// ytm-media — resolves a YouTube/YouTube Music track and streams its bytes from
// THIS machine, so the address that mints the googlevideo URL is always the
// address that fetches it. That is the whole point: those URLs are signed for
// the minting IP, so any hop in between breaks playback.
//
// No dependencies. Node 18+. One port. Nothing written to disk.
import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.YTM_SECRET || '';
if (!SECRET || SECRET.length < 16) {
  console.error('YTM_SECRET must be set to at least 16 characters');
  process.exit(1);
}

const CLIENTS = [
  {
    name: 'ANDROID',
    ua: 'com.google.android.youtube/20.22.36 (Linux; U; Android 15) gzip',
    ctx: { clientName: 'ANDROID', clientVersion: '20.22.36', androidSdkVersion: 35, osName: 'Android', osVersion: '15', hl: 'en', gl: 'US' },
  },
  {
    name: 'ANDROID_VR',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    ctx: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en', gl: 'US' },
  },
  {
    name: 'IOS',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,3; U; CPU iOS 18_3 like Mac OS X)',
    ctx: { clientName: 'IOS', clientVersion: '20.10.4', deviceModel: 'iPhone16,3', osName: 'iPhone', osVersion: '18.3.1.22D72', hl: 'en', gl: 'US' },
  },
];

const CDN_UA = 'com.google.android.youtube/20.22.36 (Linux; U; Android 15) gzip';

// Per-track memory only: a repeat request (a seek) reuses the URL for 5 minutes
// instead of spending another player call. Never persisted.
const MEMO_TTL_MS = 10 * 60 * 1000;
const memo = new Map();

function memoGet(id) {
  const hit = memo.get(id);
  if (!hit) return null;
  if (hit.exp < Date.now()) { memo.delete(id); return null; }
  return hit.val;
}
function memoSet(id, val) {
  if (memo.size >= 200) memo.delete(memo.keys().next().value);
  memo.set(id, { val, exp: Date.now() + MEMO_TTL_MS });
}

async function player(client, videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': client.ua,
      'x-goog-api-format-version': '2',
      origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({
      context: { client: client.ctx },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${client.name} HTTP ${res.status}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${client.name} non-JSON reply`); }
  const ps = j.playabilityStatus || {};
  if (ps.status !== 'OK') throw new Error(`${client.name} ${ps.status}: ${ps.reason || ''}`.trim());
  return j.streamingData || {};
}

function bestAudio(sd) {
  const list = (sd.adaptiveFormats || []).filter(
    (f) => f.url && String(f.mimeType || '').startsWith('audio/')
  );
  list.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return list[0] || null;
}

function bestVideo(sd) {
  const list = (sd.formats || []).filter(
    (f) => f.url && String(f.mimeType || '').startsWith('video/')
  );
  list.sort((a, b) => (b.height || 0) - (a.height || 0));
  return list[0] || null;
}

async function resolve(videoId) {
  const cached = memoGet(videoId);
  if (cached) return cached;
  const errors = [];
  for (const client of CLIENTS) {
    try {
      const sd = await player(client, videoId);
      const audio = bestAudio(sd);
      if (!audio) throw new Error('no audio format');
      const val = {
        audio: audio.url,
        video: bestVideo(sd)?.url || null,
        client: client.name,
      };
      memoSet(videoId, val);
      console.log(new Date().toISOString(), client.name, 'resolved', videoId);
      return val;
    } catch (e) {
      errors.push(e.message);
      console.log(new Date().toISOString(), 'resolve failed', videoId, e.message);
    }
  }
  throw new Error(errors.join(' | ') || 'no playable audio');
}

async function streamMedia(req, res, kind, videoId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let entry;
    try {
      entry = await resolve(videoId);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('resolve failed: ' + e.message);
      return;
    }

    // googlevideo signs these with rqh=1: a request without Range is refused.
    const range = req.headers.range || 'bytes=0-';
    const target = kind === 'video' ? entry.video : entry.audio;
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`no ${kind} for ${videoId}`);
      return;
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: { range, 'user-agent': CDN_UA, origin: 'https://www.youtube.com' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('cdn fetch failed: ' + e.message);
      return;
    }

    if (upstream.status === 403 || upstream.status === 401) {
      // Signature did not match the address that fetched it; mint again.
      console.log(new Date().toISOString(), 'cdn', upstream.status, 're-minting', videoId);
      memo.delete(videoId);
      continue;
    }
    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('cdn status ' + upstream.status);
      return;
    }

    const headers = {
      'content-type': kind === 'video' ? 'video/mp4' : 'audio/mp4',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'cache-control': 'private, max-age=3600',
    };
    for (const h of ['content-range', 'content-length', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }
  res.writeHead(502, { 'content-type': 'text/plain' });
  res.end('cdn kept rejecting the signed url');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, If-Range',
      'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges',
    });
    res.end();
    return;
  }

  const prefix = `/${SECRET}/`;
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const rest = url.pathname.slice(prefix.length);
  const m = /^(audio|video)\/([A-Za-z0-9_-]{6,20})$/.exec(rest);
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('bad path');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  streamMedia(req, res, m[1], m[2]).catch((e) => {
    console.log(new Date().toISOString(), 'handler error', e.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ytm-media listening on 0.0.0.0:${PORT}`);
});
