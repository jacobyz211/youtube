// ytm-media: resolves YouTube Music tracks and streams the audio bytes back.
//
// Why this exists at all: googlevideo URLs are signed against the IP that minted
// them (`ip=` sits inside the signed `sparams`), so the Worker cannot mint a URL
// on a Cloudflare egress IP and have that URL fetched from another address.
//
// Why it goes out through Cloudflare WARP: the VPS's own OVH datacenter address
// is flagged by YouTube, which answers every player call with
// "Sign in to confirm you're not a bot". WARP (WireGuard, no account needed)
// gives a clean, stable egress, so player calls succeed and the `ip=` baked into
// the media URL matches the address that later fetches it.
//
// Why the resolver probes before it returns: YouTube hands out two kinds of
// media URL. An ordinary one serves the whole file. A "limited" one dies with
// 403 after roughly 1 MiB, which is what made tracks stall halfway. A single
// one-byte request for the last byte tells the two apart, so a limited URL is
// rejected while it is still cheap and the next client is asked instead.

import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.YTM_SECRET || '';
// WARP tunnel source address (see /etc/wireguard/wgcf.conf). Empty = direct.
const WARP_LOCAL_ADDR = process.env.YTM_WARP_LOCAL_ADDR ?? '172.16.0.2';
// Optional: a signed-in YouTube cookie.
const COOKIE = process.env.YTM_COOKIE || '';
// Used only when every InnerTube client has been challenged or hands back a
// limited URL.
const YTDLP = process.env.YTM_YTDLP ?? '/home/ubuntu/.local/bin/yt-dlp';

if (!SECRET || SECRET.length < 16) {
  console.error('YTM_SECRET must be set to at least 16 characters');
  process.exit(1);
}

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// Client order matters. VISIONOS first: it needs no token, it returns plain
// progressive URLs with no signature to decipher, and its URLs serve the whole
// file. The rest are fallbacks for the videos it refuses.
const CLIENTS = [
  {
    name: 'VISIONOS',
    clientId: '101',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    ctx: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'IOS',
    clientId: '5',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    ctx: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'ANDROID_VR',
    clientId: '28',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; GB) gzip',
    ctx: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.62.27',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'ANDROID',
    clientId: '3',
    ua: 'com.google.android.youtube/20.22.36 (Linux; U; Android 15) gzip',
    ctx: {
      clientName: 'ANDROID',
      clientVersion: '20.22.36',
      androidSdkVersion: 35,
      osName: 'Android',
      osVersion: '15',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'TVHTML5',
    clientId: '7',
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
    needsThirdParty: true,
    ctx: {
      clientName: 'TVHTML5',
      clientVersion: '7.20260707.07.00',
      hl: 'en',
      gl: 'US',
    },
  },
];

// Per-track, in-RAM only. A seek re-uses the URL for a few minutes instead of
// spending another player call. Nothing touches disk, and a URL the CDN rejects
// is dropped at once and minted again.
const MEMO_TTL_MS = 5 * 60 * 1000;
const memo = new Map();

function memoGet(id) {
  const hit = memo.get(id);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    memo.delete(id);
    return null;
  }
  return hit.val;
}

function memoSet(id, val) {
  if (memo.size >= 200) memo.delete(memo.keys().next().value);
  memo.set(id, { val, exp: Date.now() + MEMO_TTL_MS });
}

// One request helper for everything: player POSTs, media GETs and probes.
// Node's global fetch cannot bind a source address, and we need that for WARP.
function request(url, { method = 'GET', headers = {}, body, timeout = 25000, follow = 0, warp = true } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
      // YouTube's HTML pages send oversized response headers.
      maxHeaderSize: 1 << 20,
      // The tunnel is IPv4; without this Node picks the AAAA record and then
      // fails to bind an IPv4 source address to it.
      family: 4,
    };
    if (warp && WARP_LOCAL_ADDR) options.localAddress = WARP_LOCAL_ADDR;

    const req = https.request(options, (res) => {
      if (follow > 0 && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).href, { method, headers, timeout, follow: follow - 1, warp }));
        return;
      }
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });

    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      // WARP down (unit stopped, address gone): retry once on the normal route
      // so the service still answers.
      if (warp && ['EINVAL', 'EADDRNOTAVAIL', 'ENETUNREACH', 'EHOSTUNREACH'].includes(err.code)) {
        request(url, { method, headers, body, timeout, follow, warp: false }).then(resolve, reject);
        return;
      }
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function readAll(res) {
  const chunks = [];
  for await (const chunk of res.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

let visitorData = '';

async function getVisitorData() {
  if (visitorData) return visitorData;
  for (const id of ['dQw4w9WgXcQ', 'kJQP7kiw5Fk']) {
    try {
      const res = await request(`https://www.youtube.com/embed/${id}`, {
        headers: { 'user-agent': WEB_UA, 'accept-language': 'en-US,en;q=0.9' },
      });
      const found = (await readAll(res)).toString().match(/"visitorData":"([^"]+)"/);
      if (found) return (visitorData = found[1]);
    } catch (e) {
      console.log(new Date().toISOString(), 'visitorData fetch failed', e.message);
    }
  }
  return '';
}

async function player(client, videoId) {
  // Every client gets a visitorData. Without it the Apple and Android clients
  // answer "Sign in to confirm you're not a bot" and, when they do answer,
  // hand back a limited URL that dies after about 1 MiB.
  const vd = await getVisitorData();
  const ctx = { ...client.ctx };
  if (vd) ctx.visitorData = vd;
  const thirdParty = client.needsThirdParty && vd ? { embedUrl: `https://www.youtube.com/embed/${videoId}` } : null;

  const body = JSON.stringify({
    context: thirdParty ? { client: ctx, thirdParty } : { client: ctx },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  });

  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'user-agent': client.ua,
    'x-youtube-client-name': client.clientId,
    'x-youtube-client-version': client.ctx.clientVersion,
    origin: 'https://www.youtube.com',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (ctx.visitorData) headers['x-goog-visitor-id'] = ctx.visitorData;
  if (COOKIE) headers.cookie = COOKIE;

  const res = await request(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers,
    body,
  });
  if (res.status !== 200) {
    res.stream.resume();
    throw new Error(`${client.name} HTTP ${res.status}`);
  }
  const j = JSON.parse((await readAll(res)).toString());
  const ps = j.playabilityStatus || {};
  if (ps.status !== 'OK') throw new Error(`${client.name} ${ps.status}: ${ps.reason || ''}`.trim());
  return j.streamingData || {};
}

// Prefer m4a/AAC: it is what the Eclipse player expects and needs no container
// muxing. Opus/WebM is the fallback.
function rankAudio(formats) {
  return formats
    .filter((f) => f.url && String(f.mimeType || '').startsWith('audio/'))
    .sort((a, b) => {
      const mp4 = (f) => (String(f.mimeType).includes('mp4') ? 1 : 0);
      return mp4(b) - mp4(a) || (b.bitrate || 0) - (a.bitrate || 0);
    });
}

// A "limited" URL answers the first ~1 MiB and then 403s, which is what made
// tracks stall. Asking for the last single byte is the cheap way to find out:
// a real URL answers 206, a limited one answers 403.
async function servesWholeFile(url, ua, total) {
  if (!total || total < 1) return true;
  try {
    const res = await request(url, { headers: { range: `bytes=${total - 1}-${total - 1}`, 'user-agent': ua } });
    res.stream.resume();
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  }
}

function ytdlpUrl(videoId, format) {
  const args = [
    '--source-address', WARP_LOCAL_ADDR,
    '-f', format,
    '-g',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '15',
    '--extractor-args', 'youtube:player_client=default,-web',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: 60000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      const url = String(stdout).split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'));
      if (!url) return reject(new Error('yt-dlp returned no url'));
      resolve(url);
    });
  });
}

async function fromYtDlp(videoId) {
  for (const format of ['bestaudio[ext=m4a]', 'bestaudio']) {
    try {
      const audio = await ytdlpUrl(videoId, format);
      const res = await request(audio, { headers: { range: 'bytes=0-0', 'user-agent': WEB_UA } });
      res.stream.resume();
      if (res.status !== 200 && res.status !== 206) continue;
      const total = Number(/\/(\d+)\s*$/.exec(res.headers['content-range'] || '')?.[1]) || null;
      if (!(await servesWholeFile(audio, WEB_UA, total))) {
        console.log(new Date().toISOString(), 'yt-dlp url is limited', videoId);
        continue;
      }
      return { audio, video: null, ua: WEB_UA, total, client: 'yt-dlp' };
    } catch (e) {
      console.log(new Date().toISOString(), 'yt-dlp failed', videoId, e.message.split('\n')[0]);
    }
  }
  return null;
}

async function resolve(videoId) {
  const cached = memoGet(videoId);
  if (cached) return cached;

  const errors = [];
  for (const client of CLIENTS) {
    try {
      const sd = await player(client, videoId);
      const audio = rankAudio(sd.adaptiveFormats || [])[0];
      if (!audio) throw new Error('no audio format');
      const total = Number(audio.contentLength) || null;

      if (!(await servesWholeFile(audio.url, client.ua, total))) {
        errors.push(`${client.name} limited url`);
        console.log(new Date().toISOString(), 'limited url', videoId, client.name);
        continue;
      }

      // Progressive video is only used by the optional /video route; the addon
      // itself only ever asks for audio.
      const video = (sd.formats || [])
        .filter((f) => f.url && String(f.mimeType || '').startsWith('video/mp4'))
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      const val = {
        audio: audio.url,
        video: video ? video.url : null,
        ua: client.ua,
        total,
        client: client.name,
      };
      memoSet(videoId, val);
      console.log(new Date().toISOString(), client.name, 'resolved', videoId, total || '');
      return val;
    } catch (e) {
      errors.push(e.message);
      console.log(new Date().toISOString(), 'resolve failed', videoId, e.message);
      // A challenged client usually means the session token has gone stale, so
      // make the next attempt fetch a fresh one.
      if (e.message.includes('LOGIN_REQUIRED')) visitorData = '';
    }
  }

  const fallback = await fromYtDlp(videoId);
  if (fallback) {
    memoSet(videoId, fallback);
    console.log(new Date().toISOString(), 'yt-dlp resolved', videoId, fallback.total || '');
    return fallback;
  }

  throw new Error(errors.join(' | ') || 'no playable audio');
}

// The player often opens more than one request for the same track (a probe and
// then the stream). Sharing the resolve keeps that from becoming two sets of
// player calls.
const inflight = new Map();

function resolveOnce(videoId) {
  const cached = memoGet(videoId);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(videoId);
  if (running) return running;
  const job = resolve(videoId).finally(() => inflight.delete(videoId));
  inflight.set(videoId, job);
  return job;
}

function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    if (!total) return null;
    const n = Number(m[2]);
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  return { start, end: end !== null && end < start ? start : end };
}

async function streamMedia(req, res, kind, videoId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let entry;
    try {
      entry = await resolveOnce(videoId);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('resolve failed: ' + e.message);
      return;
    }

    const target = kind === 'video' ? entry.video : entry.audio;
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`no ${kind} for ${videoId}`);
      return;
    }

    const total = entry.total || null;
    const range = parseRange(req.headers.range, total);
    let start = range ? range.start : 0;
    let end = range ? range.end : null;
    if (total !== null) {
      if (start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}` });
        res.end();
        return;
      }
      if (end === null || end > total - 1) end = total - 1;
    }
    if (end === null) end = start + (8 << 20) - 1;

    let upstream;
    try {
      upstream = await request(target, {
        method: 'GET',
        headers: { range: `bytes=${start}-${end}`, 'user-agent': entry.ua, origin: 'https://www.youtube.com' },
        timeout: 30000,
        follow: 3,
      });
    } catch (e) {
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('cdn fetch failed: ' + e.message);
      return;
    }

    if (upstream.status === 403 || upstream.status === 401) {
      upstream.stream.resume();
      memo.delete(videoId);
      console.log(new Date().toISOString(), 'cdn', upstream.status, 're-minting', videoId);
      continue;
    }
    if (upstream.status !== 200 && upstream.status !== 206) {
      upstream.stream.resume();
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('cdn status ' + upstream.status);
      return;
    }

    const headers = {
      'content-type': upstream.headers['content-type'] || (kind === 'video' ? 'video/mp4' : 'audio/mp4'),
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      // Never let an intermediary keep a copy of a signed URL's bytes.
      'cache-control': 'no-store',
    };
    if (range) {
      headers['content-range'] = upstream.headers['content-range'] || `bytes ${start}-${end}/${total ?? '*'}`;
      res.writeHead(206, headers);
    } else {
      if (total !== null) headers['content-length'] = String(total);
      else if (upstream.headers['content-length']) headers['content-length'] = upstream.headers['content-length'];
      res.writeHead(upstream.status === 206 && total === null ? 206 : 200, headers);
    }

    if (req.method === 'HEAD') {
      upstream.stream.resume();
      res.end();
      return;
    }
    upstream.stream.pipe(res);
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

  const prefixPath = url.pathname.slice(prefix.length);
  if (prefixPath === 'health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, warp: WARP_LOCAL_ADDR, clients: CLIENTS.map((c) => c.name) }));
    return;
  }

  const m = /^(audio|video)\/([A-Za-z0-9_-]{6,20})$/.exec(prefixPath);
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
  console.log(`ytm-media listening on 0.0.0.0:${PORT} (warp ${WARP_LOCAL_ADDR || 'off'})`);
});
