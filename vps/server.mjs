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
//
// Why bytes are pulled in 2 MiB ranges rather than one long request: googlevideo
// throttles a single long-lived read from a datacenter address down to a trickle
// (measured at 0.5 KB/s, so a 50 MB track never finished and the player skipped
// it). Re-opening the range every 2 MiB keeps the same address and the same
// signed URL, and measures ~5 MB/s.

import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { once } from 'node:events';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.YTM_SECRET || '';
// WARP tunnel source address (see /etc/wireguard/wgcf.conf). Empty = direct.
const WARP_LOCAL_ADDR = process.env.YTM_WARP_LOCAL_ADDR ?? '172.16.0.2';
// Optional: a signed-in YouTube cookie. Measured: a valid session (verified via
// account_menu) does not make licensed art tracks playable from a datacenter
// address, and pairing the cookie with a SAPISIDHASH signature makes the mobile
// clients answer 400. Left off unless someone finds a case where it helps.
const COOKIE = process.env.YTM_COOKIE || '';
// Used only when every InnerTube client has been challenged or hands back a
// limited URL.
const YTDLP = process.env.YTM_YTDLP ?? '/home/ubuntu/.local/bin/yt-dlp';
// Chunk size for the media read. Small enough that the CDN keeps serving at
// full speed, large enough that one request covers ~2 minutes of audio.
const CHUNK_BYTES = Number(process.env.YTM_CHUNK_BYTES || 2 << 20);
const MAX_REMINTS = 2;

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
  // The following five are the clients the Worker used to carry one function
  // each for. None of them is the fastest, but a track that the Apple clients
  // refuse is sometimes answered by one of these, and the race below means
  // having them costs no waiting.
  {
    name: 'ANDROID_MUSIC',
    clientId: '21',
    ua: 'com.google.android.apps.youtube.music/7.27.0 (Linux; U; Android 14) gzip',
    ctx: {
      clientName: 'ANDROID_MUSIC',
      clientVersion: '7.27.0',
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'TVHTML5_EMBEDDED',
    clientId: '85',
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
    needsThirdParty: true,
    ctx: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'MWEB',
    clientId: '2',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    ctx: {
      clientName: 'MWEB',
      clientVersion: '2.20260810.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'WEB_CREATOR',
    clientId: '62',
    ua: WEB_UA,
    ctx: {
      clientName: 'WEB_CREATOR',
      clientVersion: '1.20260530.01.00',
      clientScreen: 'EMBED',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'WEB_EMBEDDED',
    clientId: '56',
    ua: WEB_UA,
    needsThirdParty: true,
    ctx: {
      clientName: 'WEB_EMBEDDED_PLAYER',
      clientVersion: '2.20260530.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
];

// Clients are started this far apart and the first one to produce a URL that
// actually streams is the one used. Firing one, waiting for it to fail, then
// firing the next is why a cold track could sit there: the answer was often the
// fourth client along.
const CLIENT_STAGGER_MS = 120;

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
//
// Only a 401/403/410 counts as limited. googlevideo redirects (302) some range
// requests to another backend, and treating that as a failure threw away good
// URLs; a network blip is likewise not proof that the URL is limited, and the
// chunk loop re-mints on a real 403 anyway.
// Returns the size too: progressive formats often leave contentLength out, and
// the answer to the last-byte request always carries the real total.
const sizeFrom = (res) =>
  Number(/\/(\d+)\s*$/.exec(res.headers['content-range'] || '')?.[1]) ||
  (res.status === 200 ? Number(res.headers['content-length']) || null : null);

async function servesWholeFile(url, ua, total) {
  try {
    let size = total && total > 0 ? total : null;

    // Progressive formats often carry no contentLength, and without a size the
    // player cannot seek a video. One byte tells us the total.
    if (!size) {
      const first = await request(url, { headers: { range: 'bytes=0-0', 'user-agent': ua }, follow: 2, timeout: 10000 });
      first.stream.resume();
      size = sizeFrom(first);
      // A 200 means the host served the whole file and ignores ranges; that is
      // still playable, it just cannot seek.
      if (first.status === 200) return { ok: true, total: size };
      if (!size) return { ok: ![401, 403, 410].includes(first.status), total: null };
    }

    const res = await request(url, {
      headers: { range: `bytes=${size - 1}-${size - 1}`, 'user-agent': ua },
      follow: 2,
      timeout: 10000,
    });
    res.stream.resume();
    return { ok: ![401, 403, 410].includes(res.status), total: sizeFrom(res) || size };
  } catch {
    return { ok: true, total: null };
  }
}

function ytdlpUrl(videoId, format) {
  const args = [
    // Only meaningful on the VPS; a laptop has no tunnel to bind.
    ...(WARP_LOCAL_ADDR ? ['--source-address', WARP_LOCAL_ADDR] : []),
    '-f', format,
    '-g',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '15',
    '--extractor-args', 'youtube:player_client=default,-web',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: 25000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      const url = String(stdout).split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'));
      if (!url) return reject(new Error('yt-dlp returned no url'));
      resolve(url);
    });
  });
}

async function fromYtDlp(videoId) {
  for (const format of ['bestaudio[ext=m4a]/bestaudio']) {
    try {
      const audio = await ytdlpUrl(videoId, format);
      const res = await request(audio, { headers: { range: 'bytes=0-0', 'user-agent': WEB_UA } });
      res.stream.resume();
      if (res.status !== 200 && res.status !== 206) continue;
      const total = Number(/\/(\d+)\s*$/.exec(res.headers['content-range'] || '')?.[1]) || null;
      const probe = await servesWholeFile(audio, WEB_UA, total);
      if (!probe.ok) {
        console.log(new Date().toISOString(), 'yt-dlp url is limited', videoId);
        continue;
      }
      return { audio, video: null, ua: WEB_UA, total: probe.total || total, client: 'yt-dlp' };
    } catch (e) {
      console.log(new Date().toISOString(), 'yt-dlp failed', videoId, e.message.split('\n')[0]);
    }
  }
  return null;
}

// No single resolve may take longer than this, no matter what the video lookup
// is doing. A track that needs more simply starts without video.
const RESOLVE_BUDGET_MS = 900;

function raceBudget(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      if (t.unref) t.unref();
    }),
  ]);
}

// One shared ANDROID player call per track, started the moment a resolve begins.
// The muxed rendition only exists in ANDROID's response, so without this the
// video lookup ran a second player call after the audio had already resolved,
// and that call sat directly on the path between tapping a song and hearing it.
// Sharing it means the call overlaps the race instead of following it, and the
// race reuses the same answer when ANDROID is itself the winner.
const androidInflight = new Map();
const ANDROID_REUSE_MS = 60 * 1000;

function androidPlayer(videoId) {
  const hit = androidInflight.get(videoId);
  if (hit && hit.exp > Date.now()) return hit.p;
  const android = CLIENTS.find((c) => c.name === 'ANDROID');
  const p = player(android, videoId).catch((e) => {
    androidInflight.delete(videoId);
    throw e;
  });
  if (androidInflight.size > 50) androidInflight.delete(androidInflight.keys().next().value);
  androidInflight.set(videoId, { p, exp: Date.now() + ANDROID_REUSE_MS });
  return p;
}

// The muxed rendition for a track that has video. Never throws: a track that
// cannot produce one is still perfectly playable as audio.
async function findMuxed(sd, client, videoId) {
  const own = (sd.formats || [])
    .filter((f) => f.url && String(f.mimeType || '').startsWith('video/mp4'))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  try {
    let muxed = own || null;
    let muxedUa = client.ua;

    if (!muxed) {
      const android = CLIENTS.find((c) => c.name === 'ANDROID');
      const sd2 = await androidPlayer(videoId);
      const cand = (sd2.formats || []).find((f) => f.url && String(f.mimeType || '').startsWith('video/mp4'));
      if (cand) {
        const probe = await servesWholeFile(cand.url, android.ua, Number(cand.contentLength) || null);
        if (probe.ok) {
          muxed = cand;
          muxedUa = android.ua;
          if (probe.total) cand.contentLength = probe.total;
        } else {
          console.log(new Date().toISOString(), 'muxed video rejected', videoId);
        }
      }
    }

    // A muxed format taken straight from this client's response often has no
    // contentLength, and without a length the player cannot seek the video.
    if (muxed && !muxed.contentLength) {
      const own2 = await servesWholeFile(muxed.url, muxedUa, null);
      if (own2.total) muxed.contentLength = own2.total;
    }

    return { muxed, muxedUa };
  } catch (e) {
    console.log(new Date().toISOString(), 'no muxed video', videoId, e.message.slice(0, 60));
    return { muxed: own || null, muxedUa: client.ua };
  }
}

// One client's whole attempt: player call, pick the audio, prove the URL streams,
// and find the muxed rendition the player can show as video.
async function attemptClient(client, videoId) {
  const startedAt = Date.now();
  try {
    const sd = client.name === 'ANDROID' ? await androidPlayer(videoId) : await player(client, videoId);
    const audio = rankAudio(sd.adaptiveFormats || [])[0];
    if (!audio) throw new Error('no audio format');
    const total = Number(audio.contentLength) || null;

    // Eclipse plays video only when /stream offers it, and it wants one file with
    // picture AND sound ("muxed"). VISIONOS and IOS answer with adaptive formats
    // only, which are video-only, so a track that has video may cost one more
    // player call to ANDROID, which still returns the muxed 360p rendition.
    //
    // This starts BEFORE the audio probe and is awaited after it: the two are
    // independent, and doing them in sequence is what made video tracks start
    // about a second later than audio-only ones.
    const hasVideo = (sd.adaptiveFormats || []).some((f) => String(f.mimeType || '').startsWith('video/'));
    const videoTask = hasVideo ? findMuxed(sd, client, videoId).catch(() => null) : null;

    const probe = await servesWholeFile(audio.url, client.ua, total);
    if (!probe.ok) {
      console.log(new Date().toISOString(), 'limited url', videoId, client.name);
      return { limited: true, err: `${client.name} limited url` };
    }

    // The video rendition is a nice-to-have; hearing the song is not. It gets a
    // slice of the total resolve budget, so a slow or unavailable muxed format
    // cannot hold playback up the way a one-second wait on every track did.
    const videoLeft = startedAt + RESOLVE_BUDGET_MS - Date.now();
    const videoInfo = videoTask && videoLeft > 60 ? await raceBudget(videoTask, videoLeft) : null;
    const { muxed, muxedUa } = videoInfo || { muxed: null, muxedUa: client.ua };

    return {
      val: {
        audio: audio.url,
        video: muxed ? muxed.url : null,
        videoUa: muxedUa,
        videoWidth: (muxed && muxed.width) || null,
        videoHeight: (muxed && muxed.height) || null,
        // The muxed rendition is a different file with a different length, so
        // it needs its own total for range maths.
        videoTotal: (muxed && Number(muxed.contentLength)) || null,
        ua: client.ua,
        total,
        client: client.name,
      },
    };
  } catch (e) {
    console.log(new Date().toISOString(), 'resolve failed', videoId, e.message);
    // A challenged client usually means the session token has gone stale, so
    // make the next attempt fetch a fresh one.
    if (e.message.includes('LOGIN_REQUIRED')) visitorData = '';
    return { err: e.message };
  }
}

// Starts a client every CLIENT_STAGGER_MS and takes the first answer that can
// actually stream. Everything still in flight when a winner appears is ignored,
// so the wait is set by the fastest client rather than by the slowest failure.
async function raceClients(videoId) {
  const errors = [];
  let sawLimited = false;
  let settled = false;
  let outstanding = 0;
  let launchTimer = null;
  let settle;
  const won = new Promise((r) => (settle = r));

  const finish = (val) => {
    if (settled) return;
    settled = true;
    clearTimeout(launchTimer);
    settle(val);
  };

  const launch = (i) => {
    if (settled || i >= CLIENTS.length) return;
    const client = CLIENTS[i];
    outstanding++;
    attemptClient(client, videoId).then((r) => {
      outstanding--;
      if (settled) return;
      if (r.limited) sawLimited = true;
      if (r.val) {
        finish(r.val);
        return;
      }
      if (r.err) errors.push(r.err);
      if (i + 1 >= CLIENTS.length && outstanding === 0) finish(null);
    });
    launchTimer = setTimeout(() => launch(i + 1), CLIENT_STAGGER_MS);
  };

  // Start the shared ANDROID call alongside the race so the video lookup is
  // already done by the time audio wins. Failure is fine: it is only video.
  androidPlayer(videoId).catch(() => {});

  launch(0);
  const val = await won;
  return { val, sawLimited, roundErrors: errors };
}

async function resolve(videoId) {
  const cached = memoGet(videoId);
  if (cached) return cached;

  const errors = [];

  // YouTube withdraws into handing out "limited" URLs when one address asks for
  // a lot of tracks quickly. It is not sticky: the next round usually returns a
  // whole-file URL, so a round of failures is worth one more try before giving
  // up on the track.
  for (let round = 0; round < 3; round++) {
    if (round > 0) await sleep(300 * round);

    const { val, sawLimited, roundErrors } = await raceClients(videoId);
    errors.push(...roundErrors);
    if (val) {
      memoSet(videoId, val);
      console.log(new Date().toISOString(), val.client, 'resolved', videoId, val.total || '');
      return val;
    }

    // Nothing was throttled, so the track really is unplayable and another round
    // would only cost more player calls.
    if (!sawLimited) break;
  }

  // Every client saying the video is unavailable means it is gone, not that we
  // were challenged. yt-dlp agrees, so skip its two-second spawn and let the
  // player move on.
  const gone = errors.length >= CLIENTS.length && errors.every((e) => e.includes('UNPLAYABLE'));

  const fallback = gone ? null : await fromYtDlp(videoId);
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

function openChunk(target, ua, start, end) {
  return request(target, {
    method: 'GET',
    headers: { range: `bytes=${start}-${end}`, 'user-agent': ua, origin: 'https://www.youtube.com' },
    timeout: 20000,
    follow: 3,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YouTube's adaptive audio is fragmented MP4 whose ftyp major brand is "dash".
// The bytes are perfectly valid, but AVFoundation and Media Foundation both
// refuse a file they see tagged that way, which is why a track that streams
// cleanly through curl would never start in the app. Only the four brand bytes
// change, so the offsets the player asked for stay exactly where they were.
function patchBrand(buf, kind) {
  if (buf.length < 12) return buf;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return buf;
  if (buf.toString('latin1', 8, 12) !== 'dash') return buf;
  const out = Buffer.from(buf);
  out.write(kind === 'video' ? 'mp42' : 'M4A ', 8, 4, 'latin1');
  return out;
}

async function streamMedia(req, res, kind, videoId) {
  // A player that goes away mid-track must not take the process with it.
  res.on('error', () => {});
  req.on('error', () => {});

  let entry;
  try {
    entry = await resolveOnce(videoId);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('resolve failed: ' + e.message);
    return;
  }

  const pick = () => (kind === 'video' ? entry.video : entry.audio);
  if (!pick()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`no ${kind} for ${videoId}`);
    return;
  }

  const total = (kind === 'video' ? entry.videoTotal : entry.total) || null;
  const range = total !== null ? parseRange(req.headers.range, total) : null;
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

  // Declare the length up front: the player sizes its buffer from it, and a
  // chunked reply with no length is what some players sit and wait on.
  const headers = {
    'content-type': kind === 'video' ? 'video/mp4' : 'audio/mp4',
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    // Never let an intermediary keep a copy of a signed URL's bytes.
    'cache-control': 'no-store',
  };
  // A 206 without a length is sent chunked, and a player that sizes its buffer
  // from Content-Length sits on "loading" forever without ever starting. Always
  // declare it, for partial replies too.
  if (total !== null) headers['content-length'] = String(end - start + 1);
  if (range && total !== null) headers['content-range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(range && total !== null ? 206 : 200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let pos = start;
  let remints = 0;
  let retries = 0;
  // Every byte actually handed to the player, so a log line can tell a track
  // that never started from one that was delivered and rejected.
  let sent = 0;
  const beganAt = Date.now();
  console.log(new Date().toISOString(), 'get', kind, videoId, req.headers.range || 'no-range');

  while (total === null || pos <= end) {
    const chunkEnd = total === null ? pos + CHUNK_BYTES - 1 : Math.min(pos + CHUNK_BYTES - 1, end);
    const want = chunkEnd - pos + 1;

    let upstream;
    try {
      upstream = await openChunk(pick(), kind === 'video' ? entry.videoUa || entry.ua : entry.ua, pos, chunkEnd);
    } catch (e) {
      if (retries++ < 2) {
        await sleep(150 * retries);
        continue;
      }
      console.log(new Date().toISOString(), 'chunk fetch failed', videoId, pos, e.message);
      break;
    }

    // A signed URL can be rejected partway through a long track. Buying a fresh
    // one and carrying on from the same offset keeps the player's connection.
    if (upstream.status === 401 || upstream.status === 403) {
      upstream.stream.resume();
      if (remints++ < MAX_REMINTS) {
        console.log(new Date().toISOString(), 'cdn', upstream.status, 're-minting', videoId, 'at', pos);
        memo.delete(videoId);
        retries = 0;
        try {
          entry = await resolveOnce(videoId);
        } catch {
          break;
        }
        continue;
      }
      console.log(new Date().toISOString(), 'cdn kept rejecting', videoId, pos);
      break;
    }

    if (upstream.status !== 200 && upstream.status !== 206) {
      upstream.stream.resume();
      if (retries++ < 2) {
        await sleep(150 * retries);
        continue;
      }
      console.log(new Date().toISOString(), 'chunk status', upstream.status, videoId, pos);
      break;
    }

    // Only byte 0 of a 200 answer is trustworthy: the host ignored the range.
    if (upstream.status === 200 && pos !== 0) {
      upstream.stream.resume();
      break;
    }

    let got = 0;
    let failed = false;
    try {
      for await (const buf of upstream.stream) {
        if (res.destroyed) {
          upstream.stream.destroy();
          return;
        }
        const out = pos === 0 && got === 0 ? patchBrand(buf, kind) : buf;
        got += out.length;
        if (!res.write(out)) await once(res, 'drain');
        sent += out.length;
      }
    } catch {
      failed = true;
    }

    if (res.destroyed) return;
    pos += got;

    // 200 means the host sent the whole file, so there is nothing left to ask for.
    if (upstream.status === 200) break;

    // Short or empty chunk: the CDN dropped the connection, so ask again from
    // the byte we actually reached rather than handing the player a hole.
    if (got < want) {
      if (retries++ >= 3) {
        console.log(new Date().toISOString(), 'chunk stalled', videoId, pos, failed ? 'error' : 'short');
        break;
      }
      await sleep(120);
      continue;
    }
    retries = 0;
  }

  console.log(new Date().toISOString(), 'done', kind, videoId, 'sent', sent, 'of', total ?? '?', Date.now() - beganAt + 'ms', res.destroyed ? 'client-gone' : '');
  res.end();
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

  // The Worker calls this the moment a track is selected, so the player call
  // finishes while the app is still opening the stream. Shares the same memo,
  // so it never costs a second resolve.
  // The Worker calls this the moment a track is selected and waits for it, so
  // the player call finishes while the app is still opening the stream. Same
  // memo as /audio, so it never costs a second resolve. Only metadata goes back
  // — the signed media URL stays here, because it is bound to this address.
  const warm = /^prewarm\/([A-Za-z0-9_-]{6,20})$/.exec(prefixPath);
  if (warm) {
    const reply = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const startedAt = Date.now();
    resolveOnce(warm[1]).then(
      (entry) =>
        reply({
          ok: true,
          hasVideo: Boolean(entry.video),
          width: entry.videoWidth || 0,
          height: entry.videoHeight || 0,
          total: entry.total || 0,
          videoTotal: entry.videoTotal || 0,
          // Diagnostics: which client won and how long the resolve took, so a
          // slow track can be identified instead of guessed at.
          client: entry.client || '',
          ms: Date.now() - startedAt,
        }),
      (e) => reply({ ok: false, error: String(e.message || e).slice(0, 200), ms: Date.now() - startedAt })
    );
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
