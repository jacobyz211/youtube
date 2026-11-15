// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 2.13.1 (seekable proxy, fast chain, cookie everywhere)
// Changes from 2.9.17 — a last-resort transport, nothing else touched:
//   - NEW /sabr/<id>: audio streamed through YouTube's own SABR protocol
//     (googlevideo's SabrStream, the same engine as InnerTubeX's sabr/
//     package). This is the one transport that does not hand out a
//     googlevideo URL — the thing that expires, is bound to the identity that
//     asked, and answers 206 then 403 once that identity is flagged.
//     Measured on a datacenter IP, same track, same minute: direct URL 403,
//     SABR 200/200/200 and ~500 KB in 1.4 s.
//   - /stream uses it only after every client in the chain has failed, and
//     returns the proxy as `{ url: <origin>/sabr/<id>, quality: 'sabr' }`, so
//     the reply shape Eclipse consumes is unchanged.
//   - The proxy is never probed (a probe would open and throw away a session),
//     it answers `accept-ranges: none` because a SABR session has no byte
//     offsets to satisfy Range with, and it 503s with Retry-After if no
//     identity can open one.
//   - PO tokens come from the existing YT_PO_TOKEN_GENERATOR_URL when present;
//     without a generator SABR still serves everything that does not need one.
//   - Two Worker-runtime faults were found by streaming a real track through
//     `wrangler dev` (Node never showed either): googlevideo calls the fetch it
//     is handed as `this.fetchFunction(...)`, which workerd rejects as an
//     illegal invocation, and a PO-token callback that resolves to null made
//     the next segment request encode a null into the protobuf. sabr.js passes
//     an arrow and turns an empty token into undefined. Verified end to end:
//     a whole 3.4 MB track through the proxy in 1.5 s, no errors.
//
// Changes from 2.12.0 — the two complaints, both measured:
//   - SEEKING. The proxy used to relay a live SABR session, which cannot
//     answer a Range request and always restarted at zero — a seek paused the
//     track forever. It now pulls the track whole (~1.5 s for 3.4 MB), caches
//     it (isolate memory + Cache API), and serves it as a real file: correct
//     Content-Length, 206 responses and Content-Range, working HEAD. Verified
//     in workerd: bytes=3000000-3000999 returned 206 with
//     "bytes 3000000-3000999/3449447".
//   - TRACKS THAT NEVER STARTED. The chain could spend 30-40 s walking eleven
//     identities at up to 2.5 s of probe each, long after the player gave up,
//     and then hand out a proxy URL that could not open a session, leaving the
//     player retrying forever. It now has a 4 s budget, and a proxy URL is
//     only returned once the track has actually been pulled and cached.
//   - PO tokens: the token is minted against a visitor identity, and sending
//     it with a different visitor is an invalid pair — YouTube answers as if
//     no token was sent. The addon now adopts the generator's visitor while
//     its token is live, and sends the generator's API key when configured.
//   - COOKIE REACH. YT_COOKIE used to reach three of eleven player identities.
//     It is now attached to every player, search and browse call, because on a
//     datacenter IP the identities without it are the ones that fail.
// Changes from 2.9.16 — playback path untouched, chain behaviour only:
//   - ADOPTED from InnerTubeX (MetrolistGroup/innertubex), whose
//     ClientHealthMonitor records failures per client identity and stops
//     asking one that was just refused. A client that answered "Sign in to
//     confirm you're not a bot" answered it for the next several requests, so
//     the old chain paid a failed round trip on almost every track and kept
//     the verdict warm. Failures are now counted per client: a bot verdict
//     parks that identity for five minutes, two ordinary failures park it for
//     ninety seconds, and a success clears it.
//   - The sticky preferred client only leads while it is healthy; a cooling
//     client goes back into the chain instead of the head of the queue.
//   - The skip is advisory: if every identity is cooling down the chain runs
//     anyway, so a bad minute can never make a track unplayable.
// Changes from 2.9.15 — 2.9.15 stopped playback, so it is reverted in full:
//   - resolveIOS hands out the HLS manifest first again, exactly like "YouTube
//     Music Direct" (its PLAYBACK_ORDER leads with ios-hls). Preferring the
//     adaptive audio file sent every iOS reply down the gated path instead.
//   - the verification probe is back to the plain read past 1 MiB. Sizing it
//     from the URL's own clen parameter rejected links that do play fine.
//   - /stream replies are back to their 2.9.14 shape: no codec/container/
//     manifest keys. They are optional in the docs, and adding them was the one
//     thing that changed on EVERY reply when playback broke.
//   - the Direct fallback ranks sources in the module's own order:
//     ios-hls, android-progressive, android-audio, ios-audio, android-hls.
// Changes from 2.9.13:
//   - ADOPTED from the working "YouTube Music Direct" module (nvmindl, v5.3):
//     a link is now VERIFIED before it is handed out. A PO-token-gated
//     googlevideo URL answers 206 for its first megabyte and 403 after it, so
//     a probe at byte 0 passes on links that die a minute into the song. The
//     probe starts past 1 MiB; a gated verdict costs one attempt and the chain
//     moves on, while 'unknown' (timeout) is accepted.
//   - NEW last resort resolver Direct, also from that module: it asks iOS and
//     Android together, ranks every source they carry (muxed MP4 first,
//     adaptive audio, then HLS) and probes them in rank order, then repeats
//     once with a fresh visitor because bot verdicts are per-visitor.
// Changes from 2.9.12:
//   - /stream no longer stalls the queue. Three separate causes, all removed:
//       * the optional `video` lookup was awaited on the success path, adding
//         up to three player calls to every reply. It now runs alongside the
//         audio chain and is capped at 250 ms after audio resolves;
//       * every reply is a fresh resolve, so swiping spent one call (or ten)
//         per track and YouTube answered the burst with bot checks. Finished
//         resolves are now reused for six minutes from RAM only, and a second
//         request for the same track joins the one already running;
//       * the chain always started at VisionOS. The client that worked last
//         is now tried first, so a queue pays no failed-attempt sleeps;
//   - A failing /stream now answers 503 + Retry-After: 1 instead of 500, which
//     is what Eclipse retries. A 500 is treated as fatal and leaves the
//     player spinning on that track forever.
//   - Progressive audio is picked before an HLS manifest, so playback starts
//     on the first byte rather than after a playlist is parsed.
// Changes from 2.9.10:
//   - FIX: tryRefreshPoToken() sent a bare GET to YT_PO_TOKEN_GENERATOR_URL.
//     Real BotGuard-attestation PO token generators — e.g. bgutil-ytdlp-pot-
//     provider (github.com/Brainicism/bgutil-ytdlp-pot-provider), the same
//     LuanRT BgUtils-based approach clients like Metrolist use internally —
//     expose POST /get_pot with a JSON body, not GET. Fixed to POST an empty
//     JSON body; the response fields (po_token, visitor_data) already
//     matched what this function expected, so no other changes were needed.
//   - This addon's PO-token plumbing (env var, Upstash caching, withPoToken)
//     was already correct — it just never had a real generator wired up
//     behind it. Deploy bgutil-ytdlp-pot-provider (Docker image works on
//     Render/Fly/any host with a persistent process — NOT Cloudflare
//     Workers, which can't run its BotGuard interpreter) and point
//     YT_PO_TOKEN_GENERATOR_URL at its /get_pot endpoint to actually use
//     this path instead of running with zero attestation.
// Changes from 2.9.9 (REVERTED in 2.9.10):
//   - 2.9.9 had skipped clients believed to need a PO token when none was
//     cached. Production logs showed AndroidNative resolving on the FIRST
//     attempt with zero bot errors even with no PO token configured — that
//     shortcut removed the most reliable client, so 2.9.10 reverted it.
//     handleStream always tries all 9 clients again, same order as 2.9.8.
// Changes from 2.9.8:
//   - env.YT_COOKIE is now sent on the TV and TVEmbedded player calls
//     (previously the only two resolvers missing it).
// Changes from 2.9.7:
//   - Added 3 more InnerTube clients to the /stream fallback chain:
//     AndroidMusic (the YT Music app's own client — was already implemented
//     for /download but never tried for streaming), TVHTML5 ("tv" in
//     yt-dlp's current default client list), and
//     TVHTML5_SIMPLY_EMBEDDED_PLAYER ("tv_embedded", paired with a
//     thirdParty embedUrl like WebEmbedded). Chain is now 9 clients across
//     4 fingerprint families (Android app, iOS app, web, TV surface)
//     instead of 6 across 3 — TV-surface clients are a fundamentally
//     different fingerprint from mobile/web, useful when those two families
//     get flagged together.
// Changes from 2.9.6:
//   - FIX: AndroidNative/WebEmbedded/MWEB/WebCreator/AndroidVR player calls
//     previously sent NO visitorData at all in context.client — a request
//     claiming to be a real app client but with zero visitor identity is a
//     strong bot signal under YouTube's tightened 2026 enforcement (which now
//     also scrutinizes ANDROID/iOS, not just WEB). Every player-data
//     resolver now attaches a real visitorData via getVisitorData() before
//     the PO token gets layered on.
//   - FIX: withPoToken() used to overwrite context.client.visitorData with a
//     SEPARATELY cached "ytm:po_visitor_data" value that had nothing to do
//     with the visitorData already on the request — a mismatched
//     PO-token/visitorData pairing looks like tampering to BotGuard. It now
//     only attaches the PO token itself and leaves visitorData alone.
//   - Added a small randomized delay (150-400ms) between fallback resolver
//     attempts in handleStream — back-to-back player calls with zero
//     spacing from the same Workers IP is a machine-pattern signal on its
//     own, independent of which client each call claims to be. No delay is
//     added before the first attempt.
//   - Added a diagnostic log line when no PO token is cached, so a dead
//     PO-token generator shows up immediately in `wrangler tail` instead of
//     silently degrading every request.
// Changes from 2.9.5:
//   - FIX: logs showed the iOS HLS call getting bot-blocked ("Sign in to
//     confirm you're not a bot") on EVERY /stream request once it was moved
//     to run first — that's an extra iOS API call per track, which is
//     exactly what triggers YouTube's bot detection. Reverted the order:
//     AndroidNative/WebEmbedded progressive (>=240p) are tried first since
//     AndroidNative already ran for audio anyway, and iOS HLS is now only a
//     last resort for tracks where neither progressive source has anything.
//   - Added a success log line when a video actually attaches, so future
//     `wrangler tail` output shows which source won instead of only failures.
// Changes from 2.9.4:
//   - FIX: the AndroidNative/WebEmbedded "progressive" mp4 formats are often
//     ONLY available as legacy itag 17 (144p 3GP, ~100kbps, odd aspect ratio)
//     — that's what was showing up as a tiny squished/cropped video in
//     Eclipse. pickVideoRenditions requires height >= 240 to reject that
//     legacy format.
// Changes from 2.9.3:
//   - video lookup tries multiple clients (AndroidNative progressive mp4,
//     then WebEmbedded progressive mp4, then falls back to the iOS HLS
//     manifest as a muxed source) instead of only AndroidNative — YouTube
//     frequently omits progressive mp4 for a given client/video, so relying
//     on just one source meant the `video` field was almost never present.
// Changes from 2.9.2:
//   - ADDITIVE ONLY: /stream now also attaches a `video` object (per
//     eclipsemusic.app/docs "Video Playback") when a muxed rendition
//     exists. The existing audio url/format resolution logic is UNCHANGED.
//   - New addon Settings capability (searchMode, videoQuality) so users can
//     pick Songs/Videos/Both and preferred video quality from Eclipse's
//     settings cog, instead of needing separate installs.
// Changes from 2.9.1:
//   - handleStream: sequential instead of parallel (stops triggering YouTube bot detection)
//   - fetchPlayerData: stop deleting visitor data on bot blocks (keeps cache valid)
//   - handleSearch: backfill only for empty categories, keeps all 6 search types
//   - 8SPINE module support (async-free module code)

import { materializeSabrTrack, parseByteRange, serveAudioBytes, SABR_CLIENTS } from './sabr.js';

const LOG_PREFIX = '[YTMusic]';
const YTM_BASE = 'https://music.youtube.com';
const YTM_API_KEY_FALLBACK = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
function getApiKey(env) { return env?.YTM_API_KEY || YTM_API_KEY_FALLBACK; }

const VISITOR_TTL_SEC = 300;
const ECLIPSE_ADDON_IDS = new Set([
  "com.ricky.youtube-music",
  "com.ricky.youtube-music-songs",
  "com.ricky.youtube-music-videos",
]);
const ECLIPSE_ACCESS_PUBLIC_KEY_B64 = "nYyISFMpuzTWY+3qx2Ya4D+V7Yh/IJHyyPwUSdGInOQ=";

const WEB_REMIX_CONTEXT = { clientName: 'WEB_REMIX', clientVersion: '1.20260304.03.00', hl: 'en', gl: 'US' };
const IOS_CLIENT_BASE = { clientName: 'IOS', clientVersion: '20.12.4', deviceMake: 'Apple', deviceModel: 'iPhone17,3', osName: 'iPhone', osVersion: '18.4.1.22E252', hl: 'en' };
const ANDROID_MUSIC_CLIENT = { clientName: 'ANDROID_MUSIC', clientVersion: '7.27.0', androidSdkVersion: 34, hl: 'en', gl: 'US' };
const ANDROID_VR_CLIENT = { clientName: 'ANDROID_VR', clientVersion: '1.61.48', androidSdkVersion: 34, hl: 'en', gl: 'US' };
const ANDROID_VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 14; en_US) gzip';
const ANDROID_NATIVE_CLIENT = { clientName: 'ANDROID', clientVersion: '20.22.36', androidSdkVersion: 35, osName: 'Android', osVersion: '15', hl: 'en', gl: 'US' };
const ANDROID_NATIVE_UA = 'com.google.android.youtube/20.22.36 (Linux; U; Android 15)';
const MWEB_CLIENT = { clientName: 'MWEB', clientVersion: '2.20260810.01.00', hl: 'en', gl: 'US' };
const MWEB_UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const WEB_CREATOR_CLIENT = { clientName: 'WEB_CREATOR', clientVersion: '1.20260530.01.00', clientScreen: 'EMBED', hl: 'en', gl: 'US' };
const WEB_EMBEDDED_CLIENT = { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20260530.01.00', hl: 'en', gl: 'US' };
// NEW (2.9.8): additional InnerTube clients for the /stream fallback chain.
// TVHTML5 ("tv") and TVHTML5_SIMPLY_EMBEDDED_PLAYER ("tv_embedded") are two
// of yt-dlp's current default extraction clients alongside android/ios/mweb
// — TV-surface clients are a different fingerprint family from mobile/web
// entirely, which is useful when mobile+web clients are all getting flagged
// together. TV_EMBEDDED additionally carries a thirdParty.embedUrl like
// WebEmbedded, which sometimes recovers videos the plain TV client can't.
const TVHTML5_CLIENT = { clientName: 'TVHTML5', clientVersion: '7.20260815.16.00', hl: 'en', gl: 'US' };
const TVHTML5_UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.2 TV Safari/537.36';
const TV_EMBEDDED_CLIENT = { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', hl: 'en', gl: 'US' };
// NEW (2.9.12): VISIONOS — the visionOS app identity. It answers with plain
// progressive URLs (no ciphered signature) and consumes no PO token, so it is
// tried before every client that needs either.
const VISIONOS_CLIENT = { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', gl: 'US' };
const VISIONOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const VISIONOS_CLIENT_ID = '101';

const SEARCH_PARAMS = {
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  videos: 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D',
  albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  playlists: 'EgWKAQIoAWoKEAkQChAFEAMQBA%3D%3D',
};

const SEARCH_HEADERS = {
  'Content-Type': 'application/json',
  'Origin': YTM_BASE,
  'Referer': `${YTM_BASE}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const ANDROID_MUSIC_UA = 'com.google.android.apps.youtube.music/7.27.0 (Linux; U; Android 14; en_US) gzip';
const IOS_UA = 'com.google.ios.youtube/20.12.4 (iPhone17,3; U; CPU iOS 18_4_1 like Mac OS X)';

// A signed-in session is the only thing measured to clear YouTube's "confirm
// you're not a bot" verdict from a datacenter IP. Measured from this Worker's
// own egress: eleven client identities x ten popular songs, anon and with a
// valid PO token, returned zero playable results — every answer was
// LOGIN_REQUIRED or UNPLAYABLE. A cookie that only reaches three of the eleven
// identities leaves the other eight just as gated, so it goes on all of them.
function playerHeaders(extra, env) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const cookie = env?.YT_COOKIE;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

async function getPoToken(env) {
  const cached = await upstashCmd(env, 'GET', 'ytm:po_token');
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return env?.YT_PO_TOKEN || null;
}
async function getPoVisitorData(env) {
  const cached = await upstashCmd(env, 'GET', 'ytm:po_visitor_data');
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return env?.YT_VISITOR_DATA || null;
}
async function withPoToken(body, env) {
  const poToken = await getPoToken(env);
  if (!poToken) return body;
  return { ...body, serviceIntegrityDimensions: { poToken } };
}
async function tryRefreshPoToken(env) {
  const generatorUrl = env?.YT_PO_TOKEN_GENERATOR_URL;
  if (!generatorUrl) return;
  try {
    // FIX (2.9.11): a real PO-token generator like bgutil-ytdlp-pot-provider
    // (github.com/Brainicism/bgutil-ytdlp-pot-provider) — the same LuanRT
    // BotGuard-attestation approach Metrolist and yt-dlp itself rely on —
    // exposes POST /get_pot, not a bare GET. An empty JSON body is enough to
    // get a session-scoped token; its response fields (po_token,
    // visitor_data) already match what this function reads below.
    const res = await fetch(generatorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A generator exposed on the open internet is keyed; one on localhost
        // needs no header, so this is only sent when configured.
        ...(env?.YT_PO_TOKEN_GENERATOR_TOKEN ? { 'x-api-key': env.YT_PO_TOKEN_GENERATOR_TOKEN } : {}),
      },
      body: JSON.stringify({}),
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return;
    const { po_token, visitor_data } = await res.json();
    if (po_token) {
      await upstashCmd(env, 'SET', 'ytm:po_token', po_token, 'EX', 21600);
      console.log(LOG_PREFIX, 'PO token refreshed from generator');
    }
    if (visitor_data) {
      await upstashCmd(env, 'SET', 'ytm:po_visitor_data', visitor_data, 'EX', 21600);
    }
  } catch (e) {
    console.log(LOG_PREFIX, 'PO token auto-refresh failed:', e.message);
  }
}

// BotGuard hands out base64url text; SABR carries the token as raw bytes in its
// protobuf streamer context, so it has to be decoded before it is sent.
function poTokenToBytes(token) {
  try {
    const normalized = String(token).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Only called when the SABR server asks for an attestation mid-stream.
async function mintPoTokenBytes(env) {
  let token = await getPoToken(env);
  if (!token && env?.YT_PO_TOKEN_GENERATOR_URL) {
    await tryRefreshPoToken(env);
    token = await getPoToken(env);
  }
  return token ? poTokenToBytes(token) : null;
}
async function upstashCmd(env, ...args) {
  const url = env?.UPSTASH_REDIS_REST_URL, token = env?.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return (await res.json()).result ?? null;
  } catch { return null; }
}

async function getVisitorData(env, userToken) {
  // A PO token is minted against one specific visitor identity. Sending that
  // token with a different visitor is not"a bit weaker" — it is an invalid
  // pair, and YouTube answers exactly like no token was sent at all. So while
  // a token from the generator is live, its visitor wins.
  const poToken = await getPoToken(env);
  if (poToken) {
    const poVisitor = await getPoVisitorData(env);
    if (poVisitor && poVisitor.length > 4) return poVisitor;
  }
  const key = userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor';
  const cached = await upstashCmd(env, 'GET', key);
  if (cached && typeof cached === 'string' && cached.length > 4) return cached;
  return fetchFreshVisitorData(env, userToken);
}
async function fetchFreshVisitorData(env, userToken) {
  const key = userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${YTM_BASE}/youtubei/v1/visitor_id?key=${getApiKey(env)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: WEB_REMIX_CONTEXT } }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const vd = (await resp.json())?.responseContext?.visitorData || null;
      if (vd) { upstashCmd(env, 'SET', key, vd, 'EX', VISITOR_TTL_SEC); return vd; }
      throw new Error('empty visitorData');
    } catch (e) {
      console.log(LOG_PREFIX, `visitorData attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  return '';
}
function tryRefreshVisitor(data, env, userToken) {
  const vd = data?.responseContext?.visitorData;
  const key = userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor';
  if (vd) upstashCmd(env, 'SET', key, vd, 'EX', VISITOR_TTL_SEC);
}
function parseDuration(text) {
  if (!text) return 0;
  const s = String(text).trim();
  const iso = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (iso) return (parseInt(iso[1] || 0) * 3600) + (parseInt(iso[2] || 0) * 60) + parseInt(iso[3] || 0);
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}
function isDuration(text) { return /^\d{1,2}:\d{2}(:\d{2})?$/.test((text || '').trim()); }
function isBullet(text) { return /^\s*[•·]\s*$/.test(text || ''); }

// ── Artwork quality fix ──────────────────────────────────────────────────
function upscaleArtwork(url) {
  if (!url || typeof url !== 'string') return url;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    const hasSizeSuffix = /=[\w-]*$/.test(url);
    if (!hasSizeSuffix) return `${url}=w1200-h1200-l100-rj`;
    return url.replace(/=([\w-]*)$/, (match, params) => {
      if (/rj/.test(params)) return '=w1200-h1200-l100-rj';
      if (/-c(-|$)/.test(params)) return '=w1200-h1200-c-k-no';
      if (/^s\d+/.test(params)) return '=s1200';
      if (/^w\d+-h\d+/.test(params)) return '=w1200-h1200';
      return '=w1200-h1200';
    });
  }
  const ytimgMatch = url.match(/^(https?:\/\/i\.ytimg\.com\/vi(?:_webp)?\/[\w-]{6,})\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)(\.\w+)(\?.*)?$/);
  if (ytimgMatch) return `${ytimgMatch[1]}/maxresdefault${ytimgMatch[2]}${ytimgMatch[3] || ''}`;
  return url;
}

function bestThumbnail(thumbs) {
  if (!thumbs?.length) return '';
  const best = thumbs.reduce((b, t) => ((t.width || 0) > (b.width || 0) ? t : b));
  return upscaleArtwork(best.url);
}
function runsText(runs) { return (runs || []).map(r => r.text || '').join('').trim(); }
function parseInfoRuns(runs) {
  if (!runs?.length) return { artist: '', album: '', duration: '' };
  const parts = []; let cur = '';
  for (const run of runs) {
    if (isBullet(run.text)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; }
    else cur += (run.text || '');
  }
  if (cur.trim()) parts.push(cur.trim());
  let duration = '';
  if (parts.length && isDuration(parts[parts.length - 1])) duration = parts.pop();
  const typeLabels = new Set(['Song', 'Video', 'EP', 'Single', 'Podcast', 'Album', 'Playlist', 'Compilation']);
  let idx = 0;
  if (parts.length > 1 && typeLabels.has(parts[0])) idx = 1;
  return { artist: parts[idx] || '', album: parts[idx + 1] || '', duration };
}
function buildIosContext(visitorData) {
  const ctx = { ...IOS_CLIENT_BASE };
  if (visitorData) ctx.visitorData = visitorData;
  return ctx;
}

async function ytmPost(path, body, env, userToken) {
  const resp = await fetch(`${YTM_BASE}${path}`, { method: 'POST', headers: SEARCH_HEADERS, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} HTTP ${resp.status} on ${path}`);
  const data = await resp.json();
  tryRefreshVisitor(data, env, userToken);
  return data;
}
async function ytmBrowse(browseId, env, userToken) {
  try {
    return await ytmPost(`/youtubei/v1/browse?key=${getApiKey(env)}`, { context: { client: WEB_REMIX_CONTEXT }, browseId }, env, userToken);
  } catch (e) {
    console.log(LOG_PREFIX, `ytmBrowse WEB_REMIX failed (${e.message}), retrying with ANDROID_MUSIC`);
    const resp = await fetch(`${YTM_BASE}/youtubei/v1/browse?key=${getApiKey(env)}`, {
      method: 'POST',
      headers: playerHeaders({ 'User-Agent': ANDROID_MUSIC_UA }, env),
      body: JSON.stringify({ context: { client: ANDROID_MUSIC_CLIENT }, browseId }),
    });
    if (!resp.ok) throw new Error(`${LOG_PREFIX} HTTP ${resp.status} on browse (both clients failed)`);
    return resp.json();
  }
}
async function ytmSearch(query, params, env, userToken) {
  const body = { context: { client: WEB_REMIX_CONTEXT }, query };
  if (params) body.params = params;
  return ytmPost(`/youtubei/v1/search?key=${getApiKey(env)}`, body, env, userToken);
}
async function ytmSearchAndroid(query, params, env) {
  const body = { context: { client: ANDROID_MUSIC_CLIENT }, query };
  if (params) body.params = params;
  const resp = await fetch(`${YTM_BASE}/youtubei/v1/search?key=${getApiKey(env)}`, {
    method: 'POST',
    headers: playerHeaders({ 'User-Agent': ANDROID_MUSIC_UA }, env),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Android search HTTP ${resp.status}`);
  return resp.json();
}

async function ytDataChannelSearch(query, env) {
  const apiKey = env?.YOUTUBE_DATA_API_KEY;
  if (!apiKey) return [];
  try {
    const sr = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=5&q=${encodeURIComponent(query)}&key=${apiKey}`);
    if (!sr.ok) return [];
    const sd = await sr.json();
    const items = sd.items || [];
    if (!items.length) return [];
    const channelIds = items.map(i => i.snippet?.channelId || i.id?.channelId).filter(Boolean);
    const cr = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIds.join(',')}&key=${apiKey}`);
    const statsMap = new Map();
    if (cr.ok) {
      const cd = await cr.json();
      for (const ch of cd.items || []) statsMap.set(ch.id, {
        subscribers: parseInt(ch.statistics?.subscriberCount || '0'),
        thumb: ch.snippet?.thumbnails?.high?.url || ch.snippet?.thumbnails?.default?.url || '',
        title: ch.snippet?.title || '',
      });
    }
    return channelIds
      .map(id => {
        const s = statsMap.get(id);
        const fb = items.find(i => (i.snippet?.channelId || i.id?.channelId) === id);
        return {
          id,
          name: s?.title || fb?.snippet?.title || '',
          artworkURL: upscaleArtwork(s?.thumb || fb?.snippet?.thumbnails?.high?.url || ''),
          subscribers: s?.subscribers || 0,
        };
      })
      .filter(a => a.id && a.name)
      .sort((a, b) => b.subscribers - a.subscribers)
      .map(({ id, name, artworkURL }) => ({ id, name, artworkURL }));
  } catch (e) {
    console.log(LOG_PREFIX, 'ytDataChannelSearch failed:', e.message);
    return [];
  }
}
async function ytDataChannelVideos(channelId, artistName, env) {
  const apiKey = env?.YOUTUBE_DATA_API_KEY;
  if (!apiKey) return [];
  try {
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=20&key=${apiKey}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const videoIds = (data.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!videoIds.length) return [];
    const dr = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds.join(',')}&key=${apiKey}`);
    if (!dr.ok) return videoIds.map((id, i) => ({
      id,
      title: data.items[i]?.snippet?.title || 'Unknown',
      artist: artistName,
      album: '',
      duration: 0,
      artworkURL: upscaleArtwork(data.items[i]?.snippet?.thumbnails?.maxres?.url || data.items[i]?.snippet?.thumbnails?.high?.url || ''),
      format: 'aac',
    }));
    const dd = await dr.json();
    return (dd.items || []).map(v => ({
      id: v.id,
      title: v.snippet?.title || 'Unknown',
      artist: artistName,
      album: '',
      duration: parseDuration(v.contentDetails?.duration || ''),
      artworkURL: upscaleArtwork(v.snippet?.thumbnails?.maxres?.url || v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.default?.url || ''),
      format: 'aac',
    })).filter(t => t.id && t.title);
  } catch (e) {
    console.log(LOG_PREFIX, 'ytDataChannelVideos failed:', e.message);
    return [];
  }
}

async function browseChannelVideos(channelId, env, userToken) {
  const channelData = await ytmPost(`/youtubei/v1/browse?key=${getApiKey(env)}`, { context: { client: WEB_REMIX_CONTEXT }, browseId: channelId }, env, userToken);
  const tabs = channelData?.contents?.twoColumnBrowseResultsRenderer?.tabs || channelData?.contents?.singleColumnBrowseResultsRenderer?.tabs || [];
  let videosParams = null, videosBrowseId = channelId;
  for (const tab of tabs) {
    const tr = tab?.tabRenderer;
    const title = (typeof tr?.title === 'string' ? tr.title : runsText(tr?.title?.runs)).toLowerCase();
    if (title === 'videos') {
      videosParams = tr?.endpoint?.browseEndpoint?.params;
      videosBrowseId = tr?.endpoint?.browseEndpoint?.browseId || channelId;
      if (tr?.selected) return channelData;
      break;
    }
  }
  if (!videosParams) return channelData;
  return ytmPost(`/youtubei/v1/browse?key=${getApiKey(env)}`, { context: { client: WEB_REMIX_CONTEXT }, browseId: videosBrowseId, params: videosParams }, env, userToken);
}
function extractChannelVideoTracks(data, fallbackArtist) {
  const tracks = [], seenIds = new Set();
  const pushVideo = (videoId, title, durText, thumbs) => {
    if (!videoId || seenIds.has(videoId) || !title) return;
    let dur = parseDuration(durText);
    if (!dur) {
      const acc = String(durText || '');
      const m = acc.match(/(\d+)\s*minute/i), s = acc.match(/(\d+)\s*second/i);
      if (m || s) dur = (parseInt(m?.[1] || 0) * 60) + parseInt(s?.[1] || 0);
    }
    seenIds.add(videoId);
    tracks.push({ id: videoId, title, artist: fallbackArtist || '', album: '', duration: dur, artworkURL: bestThumbnail(thumbs) || '', format: 'aac' });
  };
  const addFromMRLIR = (r) => {
    if (!r) return;
    const t = parseTrackRenderer(r, fallbackArtist, '', '');
    if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); }
  };
  const allTabs = [
    ...(data?.contents?.twoColumnBrowseResultsRenderer?.tabs || []),
    ...(data?.contents?.singleColumnBrowseResultsRenderer?.tabs || []),
  ];
  for (const tab of allTabs) {
    const content = tab?.tabRenderer?.content;
    const richGrid = content?.richGridRenderer;
    if (richGrid) {
      for (const item of richGrid.contents || []) {
        const vr = item?.richItemRenderer?.content?.videoRenderer || item?.richItemRenderer?.content?.musicVideoRenderer;
        if (vr) {
          const durText = vr.lengthText?.simpleText || vr.lengthText?.accessibility?.accessibilityData?.label ||
            vr.thumbnailOverlays?.find(o => o.thumbnailOverlayTimeStatusRenderer)?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '';
          pushVideo(vr.videoId, runsText(vr.title?.runs) || vr.title?.simpleText, durText, vr.thumbnail?.thumbnails || []);
        }
        const mr = item?.richItemRenderer?.content?.musicResponsiveListItemRenderer;
        if (mr) addFromMRLIR(mr);
        if (tracks.length >= 30) break;
      }
    }
    const grid = content?.gridRenderer, secList = content?.sectionListRenderer;
    for (const item of (grid?.items || secList?.contents || [])) {
      const gvr = item?.gridVideoRenderer;
      if (gvr) {
        const durText = gvr.lengthText?.simpleText || gvr.lengthText?.accessibility?.accessibilityData?.label || '';
        pushVideo(gvr.videoId, runsText(gvr.title?.runs) || gvr.title?.simpleText, durText, gvr.thumbnail?.thumbnails || []);
      }
      const mr = item?.musicResponsiveListItemRenderer;
      if (mr) addFromMRLIR(mr);
      if (tracks.length >= 30) break;
    }
  }
  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  for (const sec of sections) {
    for (const it of sec.musicShelfRenderer?.contents || []) {
      addFromMRLIR(it.musicResponsiveListItemRenderer);
      if (tracks.length >= 30) break;
    }
  }
  return tracks;
}

function getVideoId(r) {
  if (!r) return null;
  return (
    r.playlistItemData?.videoId ||
    r.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
    (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [])
      .find(run => run.navigationEndpoint?.watchEndpoint?.videoId)
      ?.navigationEndpoint?.watchEndpoint?.videoId ||
    null
  );
}

function parseTrackRenderer(r, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  if (!r) return null;
  const videoId = getVideoId(r);
  if (!videoId) return null;
  const title = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const infoRuns = r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const info = parseInfoRuns(infoRuns);
  const fixedRaw = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
  const durationStr = (isDuration(fixedRaw) ? fixedRaw : '') || info.duration ||
    (r.lengthMs ? `${Math.floor(r.lengthMs / 60000)}:${String(Math.floor((r.lengthMs % 60000) / 1000)).padStart(2, '0')}` : '');
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    id: videoId,
    title: title || 'Unknown',
    artist: info.artist || fallbackArtist || '',
    album: info.album || fallbackAlbum || '',
    duration: parseDuration(durationStr),
    artworkURL: bestThumbnail(thumbs) || upscaleArtwork(fallbackArtwork) || '',
    format: 'aac',
  };
}

function parseAlbumItem(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const hasWatch = !!(r2.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId || r2.navigationEndpoint?.watchEndpoint);
    if (hasWatch) return null;
    const id = r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id || !id.startsWith('MPRE')) return null;
    const title = r2.title?.runs?.[0]?.text || '';
    const skip = new Set(['Album', 'EP', 'Single', 'Compilation', 'Podcast']);
    const artist = (r2.subtitle?.runs || [])
      .filter(r => !isBullet(r.text) && !/^\d{4}$/.test(r.text.trim()) && !skip.has(r.text.trim()))
      .map(r => r.text.trim()).filter(Boolean).join(' ').trim();
    return { id, title, artist, artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    if (getVideoId(r)) return null;
    const id = r.navigationEndpoint?.browseEndpoint?.browseId ||
      r.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId ||
      (r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [])
        .map(run => run.navigationEndpoint?.browseEndpoint?.browseId).find(Boolean);
    if (!id || !id.startsWith('MPRE')) return null;
    const title = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
    const info = parseInfoRuns(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
    return { id, title, artist: info.artist, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  return null;
}

function parseArtistItem(item) {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id = r.navigationEndpoint?.browseEndpoint?.browseId;
  const name = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  if (!id || !name) return null;
  return { id, name, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
}

function parseArtistItemBroad(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id = r2.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id || !id.startsWith('UC')) return null;
    const name = r2.title?.runs?.[0]?.text || '';
    if (!name) return null;
    return { id, name, artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const id = r.navigationEndpoint?.browseEndpoint?.browseId;
  if (!id || !id.startsWith('UC')) return null;
  const name = runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  if (!name) return null;
  return { id, name, artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
}
function parsePlaylistItem(item) {
  const r2 = item?.musicTwoRowItemRenderer;
  if (r2) {
    const id = r2.navigationEndpoint?.browseEndpoint?.browseId ||
      r2.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    const title = r2.title?.runs?.[0]?.text || '';
    const creator = (r2.subtitle?.runs || []).filter(r => !isBullet(r.text)).map(r => r.text.trim()).filter(Boolean)[0] || '';
    return { id, title, creator, artworkURL: bestThumbnail(r2.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  const r = item?.musicResponsiveListItemRenderer;
  if (r) {
    const id = r.navigationEndpoint?.browseEndpoint?.browseId;
    if (!id) return null;
    return { id, title: runsText(r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs), artworkURL: bestThumbnail(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []) };
  }
  return null;
}

function getShelves(data) {
  return (data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents || [])
    .map(s => s.musicShelfRenderer).filter(Boolean);
}

async function handleSearch(query, env, userToken, mode) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const m = mode || 'both';
  const fetchSongs = m === 'both' || m === 'songs';
  const fetchVideos = m === 'both' || m === 'videos';
  const fetchAlbums = m !== 'videos';

  const [songsR, videosR, albumsR, artistsR, plR, broadR] = await Promise.allSettled([
    fetchSongs ? ytmSearch(query, SEARCH_PARAMS.songs, env, userToken) : Promise.resolve(null),
    fetchVideos ? ytmSearch(query, SEARCH_PARAMS.videos, env, userToken) : Promise.resolve(null),
    fetchAlbums ? ytmSearch(query, SEARCH_PARAMS.albums, env, userToken) : Promise.resolve(null),
    ytmSearch(query, SEARCH_PARAMS.artists, env, userToken),
    ytmSearch(query, SEARCH_PARAMS.playlists, env, userToken),
    ytmSearch(query, null, env, userToken),
  ]);

  const tracks = [], albums = [], artists = [], playlists = [], seenIds = new Set();
  const addTrack = t => { if (t && !seenIds.has(t.id)) { seenIds.add(t.id); tracks.push(t); } };

  if (songsR.status === 'fulfilled' && songsR.value) for (const s of getShelves(songsR.value)) for (const it of s.contents || []) { addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if (tracks.length >= 40) break; }
  if (videosR.status === 'fulfilled' && videosR.value) for (const s of getShelves(videosR.value)) for (const it of s.contents || []) { addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if (tracks.length >= 100) break; }
  if (fetchAlbums && albumsR.status === 'fulfilled' && albumsR.value) for (const s of getShelves(albumsR.value)) for (const it of s.contents || []) { const a = parseAlbumItem(it); if (a && albums.length < 15) albums.push(a); }

  const seenArtistIds = new Set();
  if (artistsR.status === 'fulfilled' && artistsR.value) for (const s of getShelves(artistsR.value)) for (const it of s.contents || []) {
    const a = parseArtistItem(it);
    if (a && !seenArtistIds.has(a.id) && artists.length < 12) { seenArtistIds.add(a.id); artists.push(a); }
  }
  if (broadR.status === 'fulfilled' && broadR.value) {
    for (const s of getShelves(broadR.value)) for (const it of s.contents || []) {
      const a = parseArtistItemBroad(it);
      if (a && !seenArtistIds.has(a.id) && artists.length < 12) { seenArtistIds.add(a.id); artists.push(a); }
    }
    const tabs = broadR.value?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
      ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const sec of tabs) {
      const card = sec.musicCardShelfRenderer;
      if (!card) continue;
      const id = card.header?.musicCardShelfHeaderBasicRenderer?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId;
      if (id && id.startsWith('UC') && !seenArtistIds.has(id) && artists.length < 12) {
        const name = card.header?.musicCardShelfHeaderBasicRenderer?.title?.runs?.[0]?.text || '';
        const artworkURL = bestThumbnail(card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []);
        if (name) { seenArtistIds.add(id); artists.push({ id, name, artworkURL }); }
      }
    }
  }
  if (plR.status === 'fulfilled' && plR.value) for (const s of getShelves(plR.value)) for (const it of s.contents || []) { const p = parsePlaylistItem(it); if (p && playlists.length < 12) playlists.push(p); }

  // ── Sequential backfill: only for empty categories, one at a time ──
  const needTracks = fetchSongs && tracks.length === 0;
  const needAlbums = fetchAlbums && albums.length === 0;
  const needArtists = artists.length === 0;
  const needPlaylists = playlists.length === 0;

  if (needTracks) {
    try {
      const tFB = await ytmSearchAndroid(query, SEARCH_PARAMS.songs, env);
      for (const s of getShelves(tFB)) for (const it of s.contents || []) { addTrack(parseTrackRenderer(it.musicResponsiveListItemRenderer)); if (tracks.length >= 40) break; }
    } catch (e) { console.log(LOG_PREFIX, 'tracks backfill failed:', e.message); }
  }
  if (needAlbums) {
    try {
      const aFB = await ytmSearchAndroid(query, SEARCH_PARAMS.albums, env);
      for (const s of getShelves(aFB)) for (const it of s.contents || []) { const a = parseAlbumItem(it); if (a && albums.length < 15) albums.push(a); }
    } catch (e) { console.log(LOG_PREFIX, 'albums backfill failed:', e.message); }
  }
  if (needArtists) {
    try {
      const arFB = await ytmSearchAndroid(query, SEARCH_PARAMS.artists, env);
      for (const s of getShelves(arFB)) for (const it of s.contents || []) {
        const a = parseArtistItem(it);
        if (a && !seenArtistIds.has(a.id) && artists.length < 12) { seenArtistIds.add(a.id); artists.push(a); }
      }
    } catch (e) { console.log(LOG_PREFIX, 'artists backfill failed:', e.message); }
  }
  if (needPlaylists) {
    try {
      const pFB = await ytmSearchAndroid(query, SEARCH_PARAMS.playlists, env);
      for (const s of getShelves(pFB)) for (const it of s.contents || []) { const p = parsePlaylistItem(it); if (p && playlists.length < 12) playlists.push(p); }
    } catch (e) { console.log(LOG_PREFIX, 'playlists backfill failed:', e.message); }
  }
  if (needTracks || needAlbums || needArtists || needPlaylists) {
    console.log(LOG_PREFIX, `category backfill for "${query}": tracks=${needTracks} albums=${needAlbums} artists=${needArtists} playlists=${needPlaylists}`);
  }

  if (artists.length === 0) {
    const ytChannels = await ytDataChannelSearch(query, env);
    for (const ch of ytChannels) if (!seenArtistIds.has(ch.id) && artists.length < 12) { seenArtistIds.add(ch.id); artists.push(ch); }
  }

  return { tracks, albums, artists, playlists };
}
async function fetchPlayerData(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: buildIosContext(visitorData) }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`${YTM_BASE}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: playerHeaders({ 'User-Agent': IOS_UA }, env),
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') {
    const reason = data?.playabilityStatus?.reason || '';
    const status = data?.playabilityStatus?.status || '';
    // FIX: do NOT delete visitor data on bot blocks — the cache is still valid,
    // deleting it just forces a slow fresh fetch on the next request
    throw new Error(`${LOG_PREFIX} iOS blocked: ${reason || status || 'unknown'}`);
  }
  return data;
}

async function fetchPlayerDataAndroid(trackId, env, userToken) {
  const cookie = env?.YT_COOKIE || '';
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...ANDROID_MUSIC_CLIENT, visitorData } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': ANDROID_MUSIC_UA, 'X-Goog-Api-Format-Version': '2' };
  if (cookie) headers['Cookie'] = cookie;
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST', headers, body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} Android player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} Android blocked: ${data?.playabilityStatus?.reason || 'unknown'}`);
  return data;
}

// NEW (2.9.8): TVHTML5 — a fully different fingerprint family (TV surface,
// not mobile/web), useful when mobile+web clients are getting flagged as a
// group. No thirdParty embed context — this is the plain "TV app" identity.
async function fetchPlayerDataTV(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const cookie = env?.YT_COOKIE || '';
  const baseBody = { context: { client: { ...TVHTML5_CLIENT, visitorData } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': TVHTML5_UA };
  if (cookie) headers['Cookie'] = cookie;
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers,
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} TV player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} TV blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}

// NEW (2.9.8): TVHTML5_SIMPLY_EMBEDDED_PLAYER — the TV-embed variant, paired
// with a thirdParty.embedUrl like WebEmbedded. Historically recovers videos
// that reject the plain TV client (e.g. some age/region-gated content).
async function fetchPlayerDataTVEmbedded(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const cookie = env?.YT_COOKIE || '';
  const baseBody = { context: { client: { ...TV_EMBEDDED_CLIENT, visitorData }, thirdParty: { embedUrl: `https://www.youtube.com/embed/${trackId}` } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': TVHTML5_UA };
  if (cookie) headers['Cookie'] = cookie;
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers,
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} TVEmbedded player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} TVEmbedded blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}

async function fetchPlayerDataMWeb(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...MWEB_CLIENT, visitorData } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: playerHeaders({
      'User-Agent': MWEB_UA,
      'Origin': 'https://m.youtube.com', 'Referer': 'https://m.youtube.com/',
      'X-Youtube-Client-Name': '2', 'X-Youtube-Client-Version': MWEB_CLIENT.clientVersion,
    }, env),
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} MWEB player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} MWEB blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}

async function fetchPlayerDataWebCreator(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...WEB_CREATOR_CLIENT, visitorData }, thirdParty: { embedUrl: `https://www.youtube.com/embed/${trackId}` } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: playerHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Origin': 'https://www.youtube.com', 'Referer': `https://www.youtube.com/embed/${trackId}`,
    }, env),
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} WebCreator player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} WebCreator blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}

async function fetchPlayerDataAndroidNative(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...ANDROID_NATIVE_CLIENT, visitorData } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: playerHeaders({ 'User-Agent': ANDROID_NATIVE_UA, 'X-Goog-Api-Format-Version': '2' }, env),
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} AndroidNative player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} AndroidNative blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}
async function fetchPlayerDataWebEmbedded(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...WEB_EMBEDDED_CLIENT, visitorData }, thirdParty: { embedUrl: `https://www.youtube.com/embed/${trackId}` } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: playerHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Origin': 'https://www.youtube.com', 'Referer': `https://www.youtube.com/embed/${trackId}`,
    }, env),
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} WebEmbedded player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} WebEmbedded blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}

async function fetchPlayerDataAndroidVR(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...ANDROID_VR_CLIENT, visitorData } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: playerHeaders({ 'User-Agent': ANDROID_VR_UA, 'X-Goog-Api-Format-Version': '2' }, env),
    body: JSON.stringify(await withPoToken(baseBody, env)),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} AndroidVR player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} AndroidVR blocked: ${data?.playabilityStatus?.reason || 'unknown'}`);
  return data;
}

// NEW (2.9.12): VISIONOS. No cookie and no PO token are attached on purpose —
// this identity neither needs nor benefits from them, and a token it does not
// expect is itself a tamper signal.
async function fetchPlayerDataVisionOS(trackId, env, userToken) {
  const visitorData = await getVisitorData(env, userToken);
  const baseBody = { context: { client: { ...VISIONOS_CLIENT, visitorData } }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': VISIONOS_UA,
      'X-Youtube-Client-Name': VISIONOS_CLIENT_ID,
      'X-Youtube-Client-Version': VISIONOS_CLIENT.clientVersion,
      'Origin': 'https://www.youtube.com',
    },
    body: JSON.stringify(baseBody),
  });
  if (!resp.ok) throw new Error(`${LOG_PREFIX} VisionOS player HTTP ${resp.status}`);
  const data = await resp.json();
  if (data?.playabilityStatus?.status !== 'OK') throw new Error(`${LOG_PREFIX} VisionOS blocked: ${data?.playabilityStatus?.reason || data?.playabilityStatus?.status || 'unknown'}`);
  return data;
}

function pickBestAudio(sd) {
  return (sd?.adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio/mp4') && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;
}
function pickProgressiveFormat(sd) {
  const formats = sd?.formats || [];
  const candidates = formats
    .filter(f => f.url && f.mimeType && f.mimeType.startsWith('video/mp4') && f.mimeType.includes('mp4a'))
    .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
  return candidates[0] || null;
}

async function resolveAndroidNative(trackId, env, userToken) {
  const data = await fetchPlayerDataAndroidNative(trackId, env, userToken);
  const progressive = pickProgressiveFormat(data?.streamingData);
  if (progressive?.url) return { url: progressive.url, format: 'mp4', quality: 'native' };
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  throw new Error('no usable format');
}
// NEW (2.9.8): the YouTube Music app's own client identity. It was already
// implemented (fetchPlayerDataAndroid) and used for /download, but was never
// tried during /stream — a natural gap to close since it's the exact client
// a real YT Music session presents.
async function resolveAndroidMusic(trackId, env, userToken) {
  const data = await fetchPlayerDataAndroid(trackId, env, userToken);
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  throw new Error('no usable format');
}
// NEW (2.9.8): TVHTML5 — different fingerprint family (TV surface).
async function resolveTV(trackId, env, userToken) {
  const data = await fetchPlayerDataTV(trackId, env, userToken);
  // Progressive audio first: a plain file needs no playlist parsing, and the
  // app starts it on the first byte instead of after the manifest.
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return { url: hlsUrl, format: 'hls', quality: 'auto' };
  throw new Error('no usable format');
}
// NEW (2.9.8): TVHTML5_SIMPLY_EMBEDDED_PLAYER — TV-embed variant.
async function resolveTVEmbedded(trackId, env, userToken) {
  const data = await fetchPlayerDataTVEmbedded(trackId, env, userToken);
  // Progressive audio first: a plain file needs no playlist parsing, and the
  // app starts it on the first byte instead of after the manifest.
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return { url: hlsUrl, format: 'hls', quality: 'auto' };
  throw new Error('no usable format');
}
// ── Video support (ADDITIVE ONLY — eclipsemusic.app/docs "Video Playback") ──
// This never touches the audio url/format decided above. It's a completely
// separate, best-effort lookup for a muxed (video+audio in one file) source,
// attached to the stream response as an extra `video` field.
//
// IMPORTANT: YouTube's "progressive" formats array is frequently limited to
// legacy itag 17 (144p 3GP, ~100kbps, odd aspect ratio) — that's what showed
// up as a tiny squished video. We reject anything under 240p.
//
// ORDER MATTERS: AndroidNative/WebEmbedded progressive are tried FIRST
// because AndroidNative already ran once for audio — checking its result
// again here costs nothing extra client-wise. The iOS HLS manifest is only
// tried as a LAST resort: hitting it on every single track (as a previous
// version did) adds one extra iOS API call per stream request, and that's
// exactly the repeated-request pattern that gets iOS bot-blocked
// ("Sign in to confirm you're not a bot") — confirmed in production logs.
const MIN_VIDEO_HEIGHT = 240;
function pickVideoRenditions(sd) {
  const formats = sd?.formats || [];
  return formats
    .filter(f => f.url && f.mimeType && f.mimeType.startsWith('video/mp4') && f.mimeType.includes('mp4a') && (f.height || 0) >= MIN_VIDEO_HEIGHT)
    .map(f => ({ url: f.url, height: f.height, width: f.width || 0, mimeType: 'video/mp4' }))
    .sort((a, b) => b.height - a.height);
}
function buildVideoInfo(sd) {
  const renditions = pickVideoRenditions(sd);
  if (!renditions.length) return null;
  const best = renditions[0];
  return { url: best.url, mimeType: 'video/mp4', muxed: true, width: best.width || 0, height: best.height, renditions };
}
async function fetchVideoInfo(trackId, env, userToken) {
  // 1) AndroidNative progressive mp4 (>= 240p — rejects itag 17 junk)
  try {
    const data = await fetchPlayerDataAndroidNative(trackId, env, userToken);
    const info = buildVideoInfo(data?.streamingData);
    if (info) { console.log(LOG_PREFIX, `video attached via AndroidNative for ${trackId} (${info.height}p)`); return info; }
  } catch (e) {
    console.log(LOG_PREFIX, `video lookup (AndroidNative) failed for ${trackId} (non-fatal):`, e.message);
  }
  // 2) WebEmbedded progressive mp4 (same 240p floor)
  try {
    const data = await fetchPlayerDataWebEmbedded(trackId, env, userToken);
    const info = buildVideoInfo(data?.streamingData);
    if (info) { console.log(LOG_PREFIX, `video attached via WebEmbedded for ${trackId} (${info.height}p)`); return info; }
  } catch (e) {
    console.log(LOG_PREFIX, `video lookup (WebEmbedded) failed for ${trackId} (non-fatal):`, e.message);
  }
  // 3) LAST RESORT: iOS HLS manifest. Only reached when neither progressive
  //    source had a >=240p rendition, to minimize extra iOS API calls.
  try {
    const data = await fetchPlayerData(trackId, env, userToken);
    const hlsUrl = data?.streamingData?.hlsManifestUrl;
    if (hlsUrl) { console.log(LOG_PREFIX, `video attached via iOS HLS for ${trackId}`); return { url: hlsUrl, mimeType: 'application/x-mpegURL', muxed: true }; }
  } catch (e) {
    console.log(LOG_PREFIX, `video lookup (iOS HLS) failed for ${trackId} (non-fatal):`, e.message);
  }
  return null;
}
async function resolveIOS(trackId, env, userToken) {
  const data = await fetchPlayerData(trackId, env, userToken);
  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return { url: hlsUrl, format: 'hls', quality: 'auto' };
  throw new Error('no HLS');
}
async function resolveMWeb(trackId, env, userToken) {
  const data = await fetchPlayerDataMWeb(trackId, env, userToken);
  // Progressive audio first: a plain file needs no playlist parsing, and the
  // app starts it on the first byte instead of after the manifest.
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return { url: hlsUrl, format: 'hls', quality: 'auto' };
  throw new Error('no usable format');
}
async function resolveWebCreator(trackId, env, userToken) {
  const data = await fetchPlayerDataWebCreator(trackId, env, userToken);
  // Progressive audio first: a plain file needs no playlist parsing, and the
  // app starts it on the first byte instead of after the manifest.
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return { url: hlsUrl, format: 'hls', quality: 'auto' };
  throw new Error('no usable format');
}
async function resolveWebEmbedded(trackId, env, userToken) {
  const data = await fetchPlayerDataWebEmbedded(trackId, env, userToken);
  // Progressive audio first: a plain file needs no playlist parsing, and the
  // app starts it on the first byte instead of after the manifest.
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  const hlsUrl = data?.streamingData?.hlsManifestUrl;
  if (hlsUrl) return { url: hlsUrl, format: 'hls', quality: 'auto' };
  throw new Error('no usable format');
}
async function resolveAndroidVR(trackId, env, userToken) {
  const data = await fetchPlayerDataAndroidVR(trackId, env, userToken);
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  throw new Error('no usable format');
}
// NEW (2.9.12): VISIONOS resolves the licensed "- Topic" art tracks that every
// other identity answers UNPLAYABLE, so it leads the chain.
async function resolveVisionOS(trackId, env, userToken) {
  const data = await fetchPlayerDataVisionOS(trackId, env, userToken);
  const best = pickBestAudio(data?.streamingData);
  if (best) return { url: best.url, format: 'm4a', quality: 'native' };
  throw new Error('no usable format');
}
// ── NEW (2.9.14): DIRECT FALLBACK, ported from "YouTube Music Direct" ─────────
// The working Eclipse module (nvmindl, v5.3) resolves from the phone instead of
// from a Worker, but two of its ideas carry over exactly and the chain above
// does neither:
//   1. ask iOS and Android TOGETHER and keep both answers, then rank every
//      source they carry instead of settling for whichever client replied
//      first. Muxed MP4 leads (the format YouTube gates least), adaptive audio
//      next, HLS last;
//   2. verify the winner before handing it out. A PO-token-gated googlevideo
//      link serves the first megabyte happily and only then answers 403, so a
//      probe at byte 0 passes on links that die a minute into the song. The
//      probe therefore starts past 1 MiB.
// This is a LAST resort: it only runs once every cheaper identity has failed,
// and it repeats once with a fresh visitor, since bot verdicts are per-visitor.
const GATED_PREVIEW_BYTES = 1024 * 1024;
const DIRECT_PROBE_TIMEOUT_MS = 2500;

function directProbeOffset(size) {
  const pastGate = GATED_PREVIEW_BYTES + 64 * 1024;
  if (!size) return pastGate;
  if (size > pastGate + 64 * 1024) return Math.max(pastGate, Math.floor(size * 0.6));
  return Math.max(0, size - 2);
}
function directSize(format) {
  const exact = Number(format.contentLength);
  if (exact > 0) return exact;
  const bitrate = Number(format.averageBitrate || format.bitrate) || 0;
  const durationMs = Number(format.approxDurationMs) || 0;
  return Math.floor(bitrate * durationMs / 8000);
}
function directStatusClass(status) {
  if (status === 200 || status === 206) return 'ok';
  if (status === 401 || status === 403 || status === 404 || status === 410) return 'bad';
  return 'unknown';
}
async function directFetch(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    const total = Number((resp.headers.get('content-range') || '').match(/\/(\d+)$/)?.[1]) || 0;
    return { status: resp.status, total, resp };
  } catch {
    return { status: 0, total: 0, resp: null };
  } finally {
    clearTimeout(timer);
  }
}
async function directProbe(url, offset) {
  const out = await directFetch(url, { Range: `bytes=${offset}-${offset + 1}` });
  try { await out.resp?.body?.cancel(); } catch {}
  return out;
}
// 'ok' = playable, 'bad' = YouTube refused it, 'unknown' = could not tell.
async function directCheckFile(media) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let probed = await directProbe(media.url, directProbeOffset(media.size));
    // The size estimate overshot the file; probe again inside its real length.
    if (probed.status === 416 && probed.total) {
      probed = await directProbe(media.url, directProbeOffset(probed.total));
    }
    const verdict = directStatusClass(probed.status);
    if (verdict !== 'unknown') return verdict;
    if (attempt === 1) await new Promise(r => setTimeout(r, 200));
  }
  return 'unknown';
}
async function directPlaylist(url) {
  const out = await directFetch(url, {});
  const text = out.resp?.ok ? (await out.resp.text().catch(() => '')).trim() : '';
  return { status: out.status, text };
}
async function directCheckHls(media) {
  const master = await directPlaylist(media.url);
  if (directStatusClass(master.status) !== 'ok') return directStatusClass(master.status);
  if (!master.text.startsWith('#EXTM3U')) return 'bad';
  if (master.text.includes('#EXTINF')) return 'ok';
  const variantUrl = master.text.split('\n').map(l => l.trim()).find(l => /^https?:\/\//.test(l));
  if (!variantUrl) return 'bad';
  const variant = await directPlaylist(variantUrl);
  if (directStatusClass(variant.status) !== 'ok') return directStatusClass(variant.status);
  return variant.text.includes('#EXTINF') ? 'ok' : 'bad';
}
function directCheck(media) {
  return media.isHls ? directCheckHls(media) : directCheckFile(media);
}
// Ranked exactly as the module ranks them (PLAYBACK_ORDER): iOS HLS answers
// fastest, Android muxed MP4 is the format YouTube gates least, adaptive audio
// is often gated, and the remaining HLS playlist comes last.
function directCandidates(ios, android) {
  const list = [];
  const iosHls = ios?.streamingData?.hlsManifestUrl;
  if (iosHls) list.push({ source: 'ios-hls', url: iosHls, format: 'hls', size: 0, isHls: true });
  const progressive = pickProgressiveFormat(android?.streamingData);
  if (progressive?.url) list.push({ source: 'android-progressive', url: progressive.url, format: 'mp4', size: directSize(progressive), isHls: false });
  const androidAudio = pickBestAudio(android?.streamingData);
  if (androidAudio?.url) list.push({ source: 'android-audio', url: androidAudio.url, format: 'm4a', size: directSize(androidAudio), isHls: false });
  const iosAudio = pickBestAudio(ios?.streamingData);
  if (iosAudio?.url) list.push({ source: 'ios-audio', url: iosAudio.url, format: 'm4a', size: directSize(iosAudio), isHls: false });
  const androidHls = android?.streamingData?.hlsManifestUrl;
  if (androidHls) list.push({ source: 'android-hls', url: androidHls, format: 'hls', size: 0, isHls: true });
  return list;
}
async function resolveDirectFallback(trackId, env, userToken) {
  let unverified = null;
  for (let round = 1; round <= 2; round++) {
    if (round > 1) {
      await upstashCmd(env, 'DEL', userToken ? `ytm:visitor:${userToken}` : 'ytm:visitor');
      await new Promise(r => setTimeout(r, 250));
    }
    const [ios, android] = await Promise.all([
      fetchPlayerData(trackId, env, userToken).catch((e) => { console.log(LOG_PREFIX, `Direct: ios player failed for ${trackId}:`, e.message); return null; }),
      fetchPlayerDataAndroid(trackId, env, userToken).catch((e) => { console.log(LOG_PREFIX, `Direct: android player failed for ${trackId}:`, e.message); return null; }),
    ]);
    const candidates = directCandidates(ios, android);
    if (!candidates.length) {
      console.log(LOG_PREFIX, `Direct: no candidates for ${trackId} (round ${round})`);
      continue;
    }
    // Probe everything at once, but settle in rank order, so a slow low-ranked
    // probe never holds up a verified better one.
    const verdicts = candidates.map(directCheck);
    for (let i = 0; i < candidates.length; i++) {
      const verdict = await verdicts[i];
      if (verdict === 'ok') {
        console.log(LOG_PREFIX, `Direct: using ${candidates[i].source} for ${trackId} (probe ok)`);
        return { url: candidates[i].url, format: candidates[i].format, quality: 'native' };
      }
      console.log(LOG_PREFIX, `Direct: ${candidates[i].source} for ${trackId} probe=${verdict}`);
      if (verdict === 'unknown' && !unverified) unverified = candidates[i];
    }
  }
  // The network was too unreliable to verify anything; an unverified URL beats none.
  if (unverified) {
    console.log(LOG_PREFIX, `Direct: using unverified ${unverified.source} for ${trackId}`);
    return { url: unverified.url, format: unverified.format, quality: 'native' };
  }
  throw new Error('direct fallback found no source');
}
// ── FIX: Sequential stream resolution instead of parallel ──────────────
// Previously: Promise.allSettled fired all 6 resolvers at once, YouTube saw
// 6 simultaneous player API calls from the same IP and blocked them all as
// "Sign in to confirm you're not a bot". Now: try one at a time, return on
// first success. Best case = 1 API call, worst case = 6 (but sequential).
async function handleStream(trackId, env, userToken, wantVideo = false, origin = '') {
  const memo = memoGet(trackId);
  if (memo) return memo;
  const already = resolveInflight.get(trackId);
  if (already) return already;

  const task = resolveStreamOnce(trackId, env, userToken, wantVideo, origin);
  resolveInflight.set(trackId, task);
  try {
    const result = await task;
    memoPut(trackId, result);
    return result;
  } finally {
    resolveInflight.delete(trackId);
  }
}

async function resolveStreamOnce(trackId, env, userToken, wantVideo, origin = '') {
  // Always try all 9 clients (2.9.10 reverted a PO-gated skip after
  // production logs showed AndroidNative resolving fine with zero bot
  // errors even without a PO token — see changelog above).
  //
  // One inline PO-token refresh attempt still happens first if a generator
  // URL is configured and nothing is cached — this only affects what gets
  // attached to each request via withPoToken(), never which/how many
  // clients get tried.
  if (!(await getPoToken(env)) && env?.YT_PO_TOKEN_GENERATOR_URL) {
    await tryRefreshPoToken(env);
  }

  const resolvers = [
    { name: 'VisionOS', run: () => resolveVisionOS(trackId, env, userToken) },
    { name: 'AndroidNative', run: () => resolveAndroidNative(trackId, env, userToken) },
    { name: 'AndroidMusic', run: () => resolveAndroidMusic(trackId, env, userToken) },
    { name: 'iOS', run: () => resolveIOS(trackId, env, userToken) },
    { name: 'MWEB', run: () => resolveMWeb(trackId, env, userToken) },
    { name: 'WebCreator', run: () => resolveWebCreator(trackId, env, userToken) },
    { name: 'WebEmbedded', run: () => resolveWebEmbedded(trackId, env, userToken) },
    { name: 'TV', run: () => resolveTV(trackId, env, userToken) },
    { name: 'TVEmbedded', run: () => resolveTVEmbedded(trackId, env, userToken) },
    { name: 'AndroidVR', run: () => resolveAndroidVR(trackId, env, userToken) },
    // Ported last resort — see the DIRECT FALLBACK block above.
    { name: 'Direct', run: () => resolveDirectFallback(trackId, env, userToken) },
  ];
  // Sticky ordering: whatever client resolved the previous track is tried
  // first. On a queue it removes the failed-attempt sleep from almost every
  // song, and it stops re-walking a chain whose leading clients are being
  // bot-checked right now.
  // A client that is currently cooling down does not get the head of the
  // queue: the identity that worked last stays first only while it is healthy.
  if (preferredClient && !clientCoolingDown(preferredClient)) {
    const at = resolvers.findIndex((r) => r.name === preferredClient);
    if (at > 0) resolvers.unshift(...resolvers.splice(at, 1));
  }

  // Video (ADDITIVE ONLY) runs alongside the audio chain rather than after it.
  // It used to be awaited on the success path, which added up to three player
  // calls to every single /stream — the app wants an answer inside 3 seconds.
  const videoTask = wantVideo
    ? fetchVideoInfo(trackId, env, userToken).catch(() => null)
    : null;

  const resolveStartedAt = Date.now();
  for (let i = 0; i < resolvers.length; i++) {
    const resolver = resolvers[i];
    // Eclipse wants an answer in seconds. Walking eleven identities at up to
    // 2.5 s of probe each is what left tracks sitting on "preparing track"
    // forever, so the chain gives up its turn and lets the proxy answer.
    if (Date.now() - resolveStartedAt > RESOLVE_BUDGET_MS) {
      console.log(LOG_PREFIX, `resolve budget spent for ${trackId} — falling through`);
      break;
    }
    // Skip an identity that was just refused, unless it is the last hope left.
    if (clientCoolingDown(resolver.name) && resolvers.some((r) => !clientCoolingDown(r.name))) {
      console.log(LOG_PREFIX, `${resolver.name} cooling down for ${trackId}`);
      continue;
    }
    // Small randomized delay between fallback attempts only. Firing player
    // calls back-to-back is itself a machine-pattern signature.
    if (i > 0) await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 120)));
    try {
      const result = await resolver.run();
      if (result) {
        // Verify before handing it out: a PO-token-gated link answers 206 at
        // byte 0 and 403 a megabyte in, which is a track that starts and then
        // dies — or never starts, depending on where the player seeks first.
        // Only an explicit refusal costs us the attempt; 'unknown' (timeout,
        // network hiccup) is accepted, since an unverified URL beats none.
        if (resolver.name !== 'Direct') {
          const verdict = await directCheck({ url: result.url, isHls: result.format === 'hls', size: 0 });
          if (verdict === 'bad') {
            console.log(LOG_PREFIX, resolver.name + ' returned a gated link for ' + trackId + ' — trying next client');
            // Gated twice in a row means the identity, not the track, is the
            // problem — let it cool down like a bot verdict.
            noteClientFailure(resolver.name, 'gated link');
            continue;
          }
          noteClientSuccess(resolver.name);
        }
        console.log(LOG_PREFIX, `${resolver.name} resolved for ${trackId}`);
        result.expiresAt = urlExpirySeconds(result.url);
        if (videoTask) {
          // Never let an optional field hold the reply: 250 ms or nothing.
          const video = await Promise.race([videoTask, new Promise(r => setTimeout(() => r(null), 250))]);
          if (video) result.video = video;
        }
        return result;
      }
    } catch (e) {
      noteClientFailure(resolver.name, e.message);
      console.log(LOG_PREFIX, `${resolver.name} failed for ${trackId}: ${e.message}`);
    }
  }
  // Last resort: our own SABR proxy. The track is pulled and cached here, so
  // the URL handed out answers its first request immediately — and only gets a
  // URL if the pull actually succeeded, which is what stops the player from
  // spinning on a proxy that would 503 it.
  if (origin) {
    console.log(LOG_PREFIX, `every client failed for ${trackId} — warming the SABR proxy`);
    const entry = await sabrMaterialize(trackId, env, userToken);
    if (entry) {
      return {
        url: `${origin}/sabr/${trackId}`,
        format: 'm4a',
        quality: 'sabr',
        proxied: true,
        expiresAt: Math.floor(Date.now() / 1000) + 6 * 3600,
      };
    }
    console.log(LOG_PREFIX, `SABR proxy could not pull ${trackId} either`);
  }
  throw new Error(`${LOG_PREFIX} No playable audio for ${trackId} — all clients exhausted`);
}

// ── Resolve memo, RAM only ────────────────────────────────────────────────────
// Swiping through a queue used to spend a full player call — and on a bad run,
// ten of them with a sleep between each — per track, so YouTube answered the
// burst with bot checks and the next song sat on "loading". A finished resolve
// is therefore reused for a few minutes, and two requests for the same track
// (a skip landing on a track the app is already prefetching) share one call.
// Nothing is written to disk or to Redis: this dies with the isolate.
const RESOLVE_TTL_MS = 6 * 60 * 1000;
// How long the client chain may spend before the SABR proxy answers instead.
const RESOLVE_BUDGET_MS = 4000;
const MAX_MEMO = 200;
const resolveMemo = new Map();     // trackId -> { at, result }
const resolveInflight = new Map(); // trackId -> Promise
let preferredClient = null;        // the client that worked last time

// ── Client health ─────────────────────────────────────────────────────────────
// Modeled on InnerTubeX's ClientHealthMonitor (MetrolistGroup/innertubex,
// extraction/PlayerClientDirector.kt): the Kotlin client records failures per
// identity and stops asking a client that has just been refused, instead of
// re-walking the same chain from the top on every track. A client that answers
// "Sign in to confirm you're not a bot" keeps answering it for the next several
// requests, so leading with it costs the app a failed round trip per song and
// keeps the verdict warm.
//
// Advisory only: if every identity is cooling down the chain runs anyway, so a
// bad minute can never turn into a track that will not play.
const CLIENT_COOLDOWN_MS = 90 * 1000;
const CLIENT_BLOCKED_COOLDOWN_MS = 5 * 60 * 1000;
const CLIENT_FAILS_BEFORE_COOLDOWN = 2;
const clientHealth = new Map(); // client name -> { fails, until }

// Bot verdicts are per-identity and sticky; ordinary network errors are not.
function clientBotBlocked(message) {
  return /bot|sign in|login required|unusual traffic|captcha|not a robot/i.test(String(message || ''));
}

function noteClientFailure(name, message) {
  const now = Date.now();
  const prev = clientHealth.get(name) || { fails: 0, until: 0 };
  const fails = prev.fails + 1;
  const blocked = clientBotBlocked(message);
  const cooling = blocked || fails >= CLIENT_FAILS_BEFORE_COOLDOWN;
  clientHealth.set(name, {
    fails,
    until: cooling ? now + (blocked ? CLIENT_BLOCKED_COOLDOWN_MS : CLIENT_COOLDOWN_MS) : prev.until,
  });
}

function noteClientSuccess(name) {
  clientHealth.delete(name);
  preferredClient = name;
}

function clientCoolingDown(name) {
  const entry = clientHealth.get(name);
  return !!entry && entry.until > Date.now();
}

// A googlevideo link carries its own expiry; handing one out that is about to
// lapse is what makes a track fail a second after it started.
function urlExpirySeconds(u) {
  try {
    const t = Number(new URL(u).searchParams.get('expire'));
    if (Number.isFinite(t) && t > 0) return t;
  } catch {}
  return Math.floor(Date.now() / 1000) + 6 * 3600;
}

function memoGet(trackId) {
  const hit = resolveMemo.get(trackId);
  if (!hit) return null;
  const stale = Date.now() - hit.at > RESOLVE_TTL_MS;
  const expiring = hit.result?.expiresAt && hit.result.expiresAt * 1000 < Date.now() + 60 * 1000;
  if (stale || expiring) { resolveMemo.delete(trackId); return null; }
  return hit.result;
}

function memoPut(trackId, result) {
  if (resolveMemo.size >= MAX_MEMO) resolveMemo.delete(resolveMemo.keys().next().value);
  resolveMemo.set(trackId, { at: Date.now(), result });
}

async function proxyDownload(trackId, incomingRequest, env, userToken) {
  const data = await fetchPlayerDataAndroid(trackId, env, userToken);
  const sd = data.streamingData;
  if (!sd) throw new Error(`${LOG_PREFIX} No streaming data for download`);
  const best = pickBestAudio(sd);
  if (!best) throw new Error(`${LOG_PREFIX} No downloadable audio for ${trackId}`);
  const cdnUrl = best.url.includes('?') ? best.url + '&alr=yes' : best.url + '?alr=yes';
  const reqHeaders = {
    'User-Agent': ANDROID_MUSIC_UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://music.youtube.com', 'Referer': 'https://music.youtube.com/',
  };
  if (env?.YT_COOKIE) reqHeaders['Cookie'] = env.YT_COOKIE;
  const range = incomingRequest.headers.get('range');
  if (range) reqHeaders['Range'] = range;
  const upstream = await fetch(cdnUrl, { headers: reqHeaders });
  const upstreamCT = upstream.headers.get('content-type') || '';
  if (!upstream.ok && upstream.status !== 206) throw new Error(`${LOG_PREFIX} CDN ${upstream.status} for ${trackId}`);
  if (!upstreamCT.includes('audio') && !upstreamCT.includes('octet-stream') && !upstreamCT.includes('video')) {
    const preview = await upstream.text();
    throw new Error(`${LOG_PREFIX} CDN returned non-audio content-type "${upstreamCT}" — body: ${preview.slice(0, 200)}`);
  }
  const resHeaders = {
    'content-type': 'audio/mp4', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': 'no-store', 'content-disposition': `attachment; filename="${trackId}.m4a"`,
  };
  if (upstream.headers.get('content-range')) resHeaders['content-range'] = upstream.headers.get('content-range');
  if (upstream.headers.get('accept-ranges')) resHeaders['accept-ranges'] = upstream.headers.get('accept-ranges');
  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}

// ── SABR proxy (see sabr.js) ──────────────────────────────────────────────────
// The track is pulled whole over SABR, cached, and served as a real file. A
// relayed live session cannot answer Range requests (it always restarts at
// zero), which is exactly what made seeking pause the track forever.
const SABR_MEM_MAX = 6;
const SABR_MEM_TTL_MS = 30 * 60 * 1000;
const SABR_CACHE_TTL_SEC = 6 * 3600;
const sabrMemory = new Map(); // trackId -> { at, bytes, contentType }

function sabrCacheUrl(trackId) {
  return `https://sabr-cache.internal/${trackId}`;
}

async function sabrCacheGet(trackId) {
  const hit = sabrMemory.get(trackId);
  if (hit && Date.now() - hit.at < SABR_MEM_TTL_MS) return hit;
  sabrMemory.delete(trackId);
  try {
    const cached = await caches.default.match(sabrCacheUrl(trackId));
    if (!cached) return null;
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (!bytes.byteLength) return null;
    const entry = { at: Date.now(), bytes, contentType: cached.headers.get('content-type') || 'audio/mp4' };
    sabrMemory.set(trackId, entry);
    return entry;
  } catch {
    return null;
  }
}

async function sabrCachePut(trackId, entry) {
  if (sabrMemory.size >= SABR_MEM_MAX) sabrMemory.delete(sabrMemory.keys().next().value);
  sabrMemory.set(trackId, entry);
  try {
    await caches.default.put(
      sabrCacheUrl(trackId),
      new Response(entry.bytes, {
        headers: { 'content-type': entry.contentType, 'cache-control': `public, max-age=${SABR_CACHE_TTL_SEC}` },
      }),
    );
  } catch (e) {
    console.log(LOG_PREFIX, `SABR: cache write failed for ${trackId}: ${e.message}`);
  }
}

/** Pull a track over SABR once and cache it. Returns null if no identity can. */
async function sabrMaterialize(trackId, env, userToken) {
  const cached = await sabrCacheGet(trackId);
  if (cached) return cached;
  const attempts = [
    { name: 'AndroidVR', fetchPlayer: () => fetchPlayerDataAndroidVR(trackId, env, userToken), clientInfo: SABR_CLIENTS.androidVR },
    { name: 'iOS', fetchPlayer: () => fetchPlayerData(trackId, env, userToken), clientInfo: SABR_CLIENTS.ios },
  ];
  for (const attempt of attempts) {
    const startedAt = Date.now();
    try {
      const data = await attempt.fetchPlayer();
      const track = await materializeSabrTrack({
        data,
        videoId: trackId,
        clientInfo: attempt.clientInfo,
        // A generator that is not configured must not be called at all.
        mintPoToken: env?.YT_PO_TOKEN_GENERATOR_URL ? () => mintPoTokenBytes(env) : undefined,
      });
      const entry = { at: Date.now(), bytes: track.bytes, contentType: track.contentType };
      await sabrCachePut(trackId, entry);
      console.log(LOG_PREFIX, `SABR: ${attempt.name} materialized ${trackId} ${track.bytes.byteLength}B in ${Date.now() - startedAt}ms`);
      return entry;
    } catch (e) {
      console.log(LOG_PREFIX, `SABR: ${attempt.name} failed for ${trackId} after ${Date.now() - startedAt}ms: ${e.message}`);
    }
  }
  return null;
}

async function handleSabr(trackId, request, env, userToken) {
  const entry = await sabrMaterialize(trackId, env, userToken);
  if (!entry) return null;
  const range = parseByteRange(request.headers.get('range'), entry.bytes.byteLength);
  return serveAudioBytes({
    bytes: entry.bytes,
    contentType: entry.contentType,
    range,
    head: request.method === 'HEAD',
  });
}

function extractSecondaryTracks(data, fallbackArtist, fallbackAlbum, fallbackArtwork) {
  const twoCol = data?.contents?.twoColumnBrowseResultsRenderer;
  if (!twoCol) return [];
  const tracks = [];
  for (const s of twoCol?.secondaryContents?.sectionListRenderer?.contents || []) {
    const shelf = s.musicShelfRenderer || s.musicPlaylistShelfRenderer;
    if (!shelf) continue;
    for (const item of shelf.contents || []) {
      const t = parseTrackRenderer(item.musicResponsiveListItemRenderer, fallbackArtist, fallbackAlbum, fallbackArtwork);
      if (t) tracks.push(t);
    }
  }
  return tracks;
}

function extractResponsiveHeader(data) {
  const twoCol = data?.contents?.twoColumnBrowseResultsRenderer;
  const rhr = twoCol?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicResponsiveHeaderRenderer;
  if (rhr) return rhr;
  return data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicDetailHeaderRenderer || null;
}

async function handleAlbum(albumId, env, userToken) {
  const data = await ytmBrowse(albumId, env, userToken);
  const hdr = extractResponsiveHeader(data) || {};
  const albumTitle = runsText(hdr.title?.runs);
  let albumArtist = '';
  for (const run of hdr.subtitle?.runs || []) { if (run.navigationEndpoint?.browseEndpoint) { albumArtist = run.text; break; } }
  if (!albumArtist) albumArtist = runsText(hdr.straplineTextOne?.runs);
  if (!albumArtist) {
    const skip = new Set(['Album', 'EP', 'Single', 'Compilation']);
    for (const run of hdr.subtitle?.runs || []) {
      const t = run.text?.trim();
      if (t && !isBullet(t) && !skip.has(t) && !/^\d{4}$/.test(t)) { albumArtist = t; break; }
    }
  }
  const artworkURL = bestThumbnail(hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []);
  const tracks = extractSecondaryTracks(data, albumArtist, albumTitle, artworkURL);
  tracks.forEach((t, i) => { t.album = albumTitle; t.trackNumber = i + 1; if (!t.artworkURL) t.artworkURL = artworkURL; });
  return { id: albumId, title: albumTitle, artist: albumArtist, artworkURL, trackCount: tracks.length, tracks };
}
async function handleArtist(artistId, env, userToken, mode) {
  const data = await ytmBrowse(artistId, env, userToken);
  const hdr = data?.header?.musicImmersiveHeaderRenderer || data?.header?.musicVisualHeaderRenderer || {};
  const name = runsText(hdr.title?.runs) || 'Unknown Artist';
  const artworkURL = bestThumbnail(
    hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    hdr.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []
  );
  const sections = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
    ?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const rawTracks = [], albums = [];
  for (const section of sections) {
    const shelf = section.musicShelfRenderer, carousel = section.musicCarouselShelfRenderer;
    if (shelf) for (const it of shelf.contents || []) { const t = parseTrackRenderer(it.musicResponsiveListItemRenderer, name, '', ''); if (t && rawTracks.length < 15) rawTracks.push(t); }
    if (carousel) for (const it of carousel.contents || []) { const a = parseAlbumItem(it); if (a && albums.length < 30) albums.push({ ...a, artist: a.artist || name }); }
  }

  if (mode === 'videos') {
    let topTracks = [];
    try {
      const channelData = await browseChannelVideos(artistId, env, userToken);
      topTracks = extractChannelVideoTracks(channelData, name);
    } catch (e) { console.log(LOG_PREFIX, 'channel browse failed:', e.message); }
    if (topTracks.length === 0 && env?.YOUTUBE_DATA_API_KEY) {
      try { topTracks = await ytDataChannelVideos(artistId, name, env); } catch (e) { console.log(LOG_PREFIX, 'ytData videos fallback failed:', e.message); }
    }
    if (topTracks.length === 0) {
      try {
        const vr = await ytmSearch(name, SEARCH_PARAMS.videos, env, userToken);
        const seenIds = new Set(), nameLower = name.toLowerCase();
        for (const shelf of getShelves(vr)) for (const it of shelf.contents || []) {
          const t = parseTrackRenderer(it.musicResponsiveListItemRenderer, name, '', '');
          if (t && !seenIds.has(t.id)) {
            if (!t.artist || t.artist.toLowerCase().includes(nameLower) || nameLower.includes(t.artist.toLowerCase())) { seenIds.add(t.id); topTracks.push(t); }
          }
          if (topTracks.length >= 20) break;
        }
      } catch (e) { console.log(LOG_PREFIX, 'video search fallback failed:', e.message); }
    }
    return { id: artistId, name, artworkURL, bio: null, topTracks, albums };
  }

  let topTracks = rawTracks;
  if (topTracks.length === 0) {
    try {
      const sr = await ytmSearch(name, SEARCH_PARAMS.songs, env, userToken);
      const seenIds = new Set(), nameLower = name.toLowerCase();
      for (const shelf of getShelves(sr)) for (const it of shelf.contents || []) {
        const t = parseTrackRenderer(it.musicResponsiveListItemRenderer, name, '', '');
        if (t && !seenIds.has(t.id)) {
          if (!t.artist || t.artist.toLowerCase().includes(nameLower) || nameLower.includes(t.artist.toLowerCase())) { seenIds.add(t.id); topTracks.push(t); }
        }
        if (topTracks.length >= 15) break;
      }
      console.log(LOG_PREFIX, `artist top-tracks fallback recovered ${topTracks.length} for "${name}"`);
    } catch (e) { console.log(LOG_PREFIX, 'artist top-tracks fallback failed:', e.message); }
  }
  if (topTracks.some(t => t.duration === 0)) {
    try {
      const sr = await ytmSearch(name, SEARCH_PARAMS.songs, env, userToken);
      const dMap = new Map();
      for (const shelf of getShelves(sr)) for (const it of shelf.contents || []) {
        const r = it.musicResponsiveListItemRenderer;
        if (!r) continue;
        const vid = getVideoId(r);
        if (!vid) continue;
        const info = parseInfoRuns(r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
        const fixRaw = r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
        const dur = (isDuration(fixRaw) ? fixRaw : '') || info.duration;
        if (vid && dur) dMap.set(vid, parseDuration(dur));
      }
      for (const t of topTracks) if (t.duration === 0 && dMap.has(t.id)) t.duration = dMap.get(t.id);
    } catch (e) { console.log(LOG_PREFIX, 'duration enrich failed:', e.message); }
  }
  topTracks = topTracks.filter(t => t.duration > 0);
  return { id: artistId, name, artworkURL, bio: null, topTracks, albums };
}

async function handlePlaylist(playlistId, env, userToken) {
  const browseId = playlistId.startsWith('VL') ? playlistId : 'VL' + playlistId;
  const data = await ytmBrowse(browseId, env, userToken);
  const hdr = extractResponsiveHeader(data) || {};
  const title = runsText(hdr.title?.runs) || 'Playlist';
  const creator = (hdr.subtitle?.runs || [])
    .filter(r => !isBullet(r.text) && r.text !== 'Playlist')
    .map(r => r.text.trim()).filter(Boolean).join('').trim();
  const artworkURL = bestThumbnail(hdr.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || hdr.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || []);
  const tracks = extractSecondaryTracks(data);
  return { id: playlistId, title, creator, artworkURL, trackCount: tracks.length, tracks };
}

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
function isValidToken(t) { return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(p) {
  const m = p.match(/^\/u\/([a-f0-9]{28})\/(songs|videos)(\/.*)?$/);
  if (m) return { token: m[1], mode: m[2], rest: m[3] || '/' };
  const m2 = p.match(/^\/u\/([a-f0-9]{28})(\/.*)?$/);
  return m2 ? { token: m2[1], mode: 'both', rest: m2[2] || '/' } : null;
}
function lastSegment(rest) { return rest.split('/').filter(Boolean).pop() || ''; }
function buildManifest(mode) {
  const m = mode || 'both';
  const variants = {
    both: { id: 'com.ricky.youtube-music', name: 'YouTube Music', description: 'Stream from YouTube Music — Songs & Videos, Albums, Artists, Playlists. HLS + AAC.' },
    songs: { id: 'com.ricky.youtube-music-songs', name: 'YouTube Music — Songs', description: 'Stream from YouTube Music — Songs tab only. Albums, Artists & Playlists. HLS + AAC.' },
    videos: { id: 'com.ricky.youtube-music-videos', name: 'YouTube Music — Videos', description: 'Stream from YouTube Music — Videos tab. Artists & Playlists. HLS + AAC.' },
  };
  const v = variants[m] || variants.both;
  return {
    id: v.id, name: v.name, version: '2.13.1', description: v.description,
    icon: 'https://www.gstatic.com/youtube/media/ytm/images/applauncher/music_icon_144x144.png',
    resources: ['search', 'stream', 'download', 'catalog', 'settings'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
    // Addon Settings capability (eclipsemusic.app/docs → "Addon Settings").
    // Eclipse shows a settings cog and appends these as query params
    // (?searchMode=...&videoQuality=...) on every request. Purely additive —
    // reading them is optional; defaults keep old installs working unchanged.
    settings: [
      {
        key: 'searchMode',
        type: 'select',
        label: 'Search results',
        help: 'Choose whether search returns songs, videos, or both.',
        default: m,
        options: [
          { value: 'both', label: 'Songs & Videos' },
          { value: 'songs', label: 'Songs only' },
          { value: 'videos', label: 'Videos only' },
        ],
      },
      {
        key: 'videoQuality',
        type: 'select',
        label: 'Video quality',
        help: 'Used when a track offers multiple video renditions.',
        default: '1080p',
        options: [
          { value: '2160p', label: '4K' },
          { value: '1080p', label: '1080p' },
          { value: '720p', label: '720p' },
        ],
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ── 8SPINE MODULE SUPPORT ──────────────────────────────────────────────
//   /8spine.js            → module code (both mode)
//   /8spine-songs.js     → module code (songs mode)
//   /8spine-videos.js    → module code (videos mode)
//   /8spine-source.json  → source listing for 8SPINE's "Add Source" screen
// ═══════════════════════════════════════════════════════════════════════
function buildSpineModuleSource(mode, origin) {
  const variants = {
    both:   { id: 'com.ricky.youtube-music-8spine',        name: 'YouTube Music (Songs & Videos)', qs: '' },
    songs:  { id: 'com.ricky.youtube-music-8spine-songs',  name: 'YouTube Music (Songs)',          qs: '&mode=songs' },
    videos: { id: 'com.ricky.youtube-music-8spine-videos', name: 'YouTube Music (Videos)',         qs: '&mode=videos' },
  };
  const v = variants[mode] || variants.both;
  return [
    "var YTM_8SPINE_BASE = '" + origin + "';",
    "var YTM_8SPINE_QS = '" + v.qs + "';",
    "",
    "var MODULE = {",
    "  id: '" + v.id + "',",
    "  name: '" + v.name + "',",
    "  version: '2.9.2',",
    "  labels: ['AAC', 'HLS', 'FREE'],",
    "",
    "  searchTracks: function(query, limit) {",
    "    return fetch(YTM_8SPINE_BASE + '/search?q=' + encodeURIComponent(query) + YTM_8SPINE_QS)",
    "      .then(function(res) { return res.json(); })",
    "      .then(function(data) {",
    "        var tracks = (data.tracks || []).slice(0, limit || 40).map(function(t) {",
    "          return { id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, albumCover: t.artworkURL };",
    "        });",
    "        return { tracks: tracks, total: tracks.length };",
    "      });",
    "  },",
    "",
    "  getTrackStreamUrl: function(trackId, quality) {",
    "    return fetch(YTM_8SPINE_BASE + '/stream/' + trackId)",
    "      .then(function(res) { return res.json(); })",
    "      .then(function(data) {",
    "        return {",
    "          streamUrl: data.url,",
    "          track: { id: trackId, audioQuality: data.format === 'hls' ? 'LOSSLESS' : 'HIGH' }",
    "        };",
    "      });",
    "  },",
    "",
    "  getAlbum: function(id) {",
    "    return fetch(YTM_8SPINE_BASE + '/album/' + id)",
    "      .then(function(res) { return res.json(); })",
    "      .then(function(data) {",
    "        return {",
    "          album: { id: data.id, title: data.title, artist: data.artist, albumCover: data.artworkURL },",
    "          tracks: (data.tracks || []).map(function(t) {",
    "            return { id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, albumCover: t.artworkURL };",
    "          })",
    "        };",
    "      });",
    "  },",
    "",
    "  getArtist: function(id) {",
    "    return fetch(YTM_8SPINE_BASE + '/artist/' + id + YTM_8SPINE_QS)",
    "      .then(function(res) { return res.json(); })",
    "      .then(function(data) {",
    "        return {",
    "          artist: { id: data.id, name: data.name, albumCover: data.artworkURL },",
    "          tracks: (data.topTracks || []).map(function(t) {",
    "            return { id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, albumCover: t.artworkURL };",
    "          })",
    "        };",
    "      });",
    "  }",
    "};",
    "",
    "return MODULE;"
  ].join("\n");
}

function buildSpineSource(origin) {
  return {
    'category:music': [
      {
        id: 'ytmusic-8spine-both',
        name: 'YouTube Music',
        author: 'Ricky',
        version: '2.9.2',
        description: 'Full YouTube Music catalog — Songs & Videos, Albums, Artists, Playlists. HLS + AAC. No account required.',
        labels: ['AAC', 'HLS', 'FREE'],
        download: `${origin}/8spine.js`,
      },
      {
        id: 'ytmusic-8spine-songs',
        name: 'YouTube Music — Songs',
        author: 'Ricky',
        version: '2.9.2',
        description: 'YouTube Music Songs tab only, plus Albums, Artists & Playlists. HLS + AAC. No account required.',
        labels: ['AAC', 'HLS', 'FREE'],
        download: `${origin}/8spine-songs.js`,
      },
      {
        id: 'ytmusic-8spine-videos',
        name: 'YouTube Music — Videos',
        author: 'Ricky',
        version: '2.9.2',
        description: 'YouTube Music Videos tab, plus Artists & Playlists. HLS + AAC. No account required.',
        labels: ['AAC', 'HLS', 'FREE'],
        download: `${origin}/8spine-videos.js`,
      },
    ],
  };
}
let cachedEclipsePublicKey = null;
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToBytes(b64url) {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}
async function getEclipsePublicKey() {
  if (cachedEclipsePublicKey) return cachedEclipsePublicKey;
  cachedEclipsePublicKey = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(ECLIPSE_ACCESS_PUBLIC_KEY_B64),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return cachedEclipsePublicKey;
}
async function checkEclipseAccess(request) {
  try {
    const header = request.headers.get("x-eclipse-access");
    if (!header) return null;
    const parts = header.split(".");
    if (parts.length !== 3 || parts[0] !== "ea1") return null;
    const [prefix, body, sig] = parts;

    const pubKey = await getEclipsePublicKey();
    const valid = await crypto.subtle.verify(
      "Ed25519",
      pubKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${prefix}.${body}`)
    );
    if (!valid) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!claims || !ECLIPSE_ADDON_IDS.has(claims.aud)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;

    return claims;
  } catch (e) {
    return null;
  }
}
function eclipseAccessDeniedResponse() {
  return jsonRes({ error: "Unavailable" }, 403);
}
async function handleRoute(rest, url, request, env, userToken, mode) {
  const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
  // Settings capability: Eclipse appends declared setting keys as query params
  // on every request. `searchMode` overrides the URL-path mode when present,
  // so a single install can be switched Songs/Videos/Both from Eclipse's
  // settings cog. Purely additive — falls back to the old path-based mode.
  const settingMode = url.searchParams.get('searchMode');
  const effectiveMode = (settingMode === 'both' || settingMode === 'songs' || settingMode === 'videos') ? settingMode : mode;
  // ── 8SPINE source listing ─────────────────────────────────────────────
  if (rest === '/8spine-source.json') return jsonRes(buildSpineSource(url.origin));
  // ── 8SPINE module code endpoints ─────────────────────────────────────
  if (rest === '/8spine.js') {
    return new Response(buildSpineModuleSource('both', url.origin), {
      status: 200,
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  }
  if (rest === '/8spine-songs.js') {
    return new Response(buildSpineModuleSource('songs', url.origin), {
      status: 200,
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  }
  if (rest === '/8spine-videos.js') {
    return new Response(buildSpineModuleSource('videos', url.origin), {
      status: 200,
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
    });
  }
  if (rest === '/manifest.json' || rest === '/manifest') return jsonRes(buildManifest(mode));
  const ECLIPSE_GATED_PREFIXES = ["/search", "/stream", "/download", "/album", "/artist", "/playlist", "/sabr"];
if (ECLIPSE_GATED_PREFIXES.some((p) => rest === p || rest.startsWith(p + "/"))) {
  const eclipseClaims = await checkEclipseAccess(request);
  if (!eclipseClaims) return eclipseAccessDeniedResponse();
}
  if (rest === '/search') return jsonRes(await handleSearch(q, env, userToken, effectiveMode));
  if (rest.startsWith('/stream/')) {
    const id = lastSegment(rest);
    if (!id) return jsonRes({ error: 'Missing ID' }, 400);
    const startedAt = Date.now();
    try {
      const body = await handleStream(id, env, userToken, effectiveMode !== 'songs', url.origin);
      // Visible in `wrangler tail`: a skip that took 3 s shows up as one line.
      console.log(LOG_PREFIX, `stream ${id} in ${Date.now() - startedAt}ms via ${body?.format || '?'}`);
      return jsonRes(body);
    } catch (e) {
      // Answer retryably instead of hanging: Eclipse honours Retry-After, so a
      // track whose clients are all bot-checked this second is retried a second
      // later instead of leaving the player spinning.
      console.log(LOG_PREFIX, `stream unavailable for ${id}: ${e.message}`);
      return new Response(JSON.stringify({ error: 'Not ready' }), {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
          'retry-after': '1',
        },
      });
    }
  }
  if (rest.startsWith('/sabr/')) {
    const id = lastSegment(rest);
    if (!id) return jsonRes({ error: 'Missing ID' }, 400);
    const streamed = await handleSabr(id, request, env, userToken);
    if (streamed) return streamed;
    return new Response(JSON.stringify({ error: 'Not ready' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'retry-after': '1' },
    });
  }
  if (rest.startsWith('/download/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing ID' }, 400); return await proxyDownload(id, request, env, userToken); }
  if (rest.startsWith('/album/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing ID' }, 400); return jsonRes(await handleAlbum(id, env, userToken)); }
  if (rest.startsWith('/artist/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing ID' }, 400); return jsonRes(await handleArtist(id, env, userToken, effectiveMode)); }
  if (rest.startsWith('/playlist/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing ID' }, 400); return jsonRes(await handlePlaylist(id, env, userToken)); }
  return null;
}

function jsonRes(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Range',
      'cache-control': 'no-store',
    },
  });
}
function htmlRes(b) { return new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8' } }); }
function buildPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube Music</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}
.card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}
h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}
p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}
.tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}
.tip b{color:#ccc}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#181818;color:#aaa;border:1px solid #2a2a2a}
.pill.hi{background:#1a0d10;color:#ff4d6d;border-color:#3a1520}
.pill.bl{background:#0d1520;color:#4a9eff;border-color:#1a3050}
.pill.gr{background:#0a1a0a;color:#4eba4e;border-color:#1a3a1a}
input{width:100%;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;color:#e0e0e0;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}
input:focus{border-color:#fff}
input::placeholder{color:#2e2e2e}
.hint{font-size:12px;color:#3a3a3a;margin-bottom:12px;line-height:1.7}
button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:6px;transition:background .15s}
.bw{background:#fff;color:#000}
.bw:hover{background:#e0e0e0}
.bw:disabled{background:#1e1e1e;color:#333;cursor:not-allowed}
.bg{background:#141414;color:#e0e0e0;border:1px solid #2a2a2a}
.bg:hover{background:#1e1e1e}
.bg:disabled{background:#0f0f0f;color:#333;cursor:not-allowed}
.bd{background:#0f0f0f;color:#777;border:1px solid #1a1a1a;font-size:13px;padding:10px}
.bd:hover{background:#1a1a1a;color:#fff}
.box{display:none;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:12px;padding:18px;margin-bottom:10px}
.blbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.burl{font-size:12px;color:#fff;word-break:break-all;font-family:"SF Mono","Fira Code",monospace;margin-bottom:14px;line-height:1.5}
hr{border:none;border-top:1px solid #161616;margin:24px 0}
.steps{display:flex;flex-direction:column;gap:12px}
.step{display:flex;gap:12px;align-items:flex-start}
.sn{background:#161616;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}
.st{font-size:13px;color:#555;line-height:1.6}
.st b{color:#999}
.warn{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#555;line-height:1.7}
footer{margin-top:32px;font-size:12px;color:#2a2a2a;text-align:center;line-height:1.8}
</style>
</head>
<body>
<div class="card">
<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="margin-bottom:22px" aria-label="YouTube Music">
<circle cx="26" cy="26" r="26" fill="#ff0000"/>
<rect x="11" y="20" width="4" height="12" rx="2" fill="white"/>
<rect x="18" y="14" width="4" height="24" rx="2" fill="white"/>
<rect x="25" y="18" width="4" height="16" rx="2" fill="white"/>
<rect x="32" y="11" width="4" height="30" rx="2" fill="white"/>
<rect x="39" y="17" width="4" height="18" rx="2" fill="white"/>
</svg>
<h1>YouTube Music for Eclipse</h1>
<p class="sub">Full YouTube Music catalog &mdash; Songs, Videos, Albums, Artists &amp; Playlists. No account required.</p>
<div class="tip"><b>Save your URLs.</b> Paste one below any time to copy it again without reinstalling.</div>
<div class="pills">
<span class="pill">Songs &middot; Videos</span>
<span class="pill">Albums &middot; Artists &middot; Playlists</span>
<span class="pill hi">HLS Streaming</span>
<span class="pill gr">Proxied AAC Downloads</span>
<span class="pill gr">Offline Playback</span>
<span class="pill gr">Upstash Redis</span>
<span class="pill bl">No Account</span>
</div>
<button class="bw" id="genBtn" onclick="generate()">Generate My Addon URLs</button>
<div class="box" id="genBox">
<div class="blbl">Songs &amp; Videos (both) &mdash; paste into Eclipse</div>
<div class="burl" id="urlBoth"></div>
<div class="blbl">Songs only</div>
<div class="burl" id="urlSongs"></div>
<div class="blbl">Videos only</div>
<div class="burl" id="urlVideos"></div>
<button class="bg" onclick="copyUrl('both')">Copy Songs &amp; Videos URL</button>
<button class="bg" onclick="copyUrl('songs')">Copy Songs URL</button>
<button class="bg" onclick="copyUrl('videos')">Copy Videos URL</button>
</div>
<input id="savedUrl" placeholder="Paste a saved URL here to copy it again" oninput="checkSaved()">
<button class="bd" id="reCopyBtn" disabled onclick="reCopy()">Copy Saved URL</button>
<hr>
<h2>How to install</h2>
<div class="steps">
<div class="step"><div class="sn">1</div><div class="st">Tap <b>Generate My Addon URLs</b> above</div></div>
<div class="step"><div class="sn">2</div><div class="st">Copy the URL for the tab you want</div></div>
<div class="step"><div class="sn">3</div><div class="st">Open <b>Eclipse</b> &rarr; Settings &rarr; Addons &rarr; Add Addon &rarr; paste the URL</div></div>
</div>
<div class="warn">Each URL is unique to your session. Regenerating creates a new URL; old ones keep working.</div>
</div>
<footer>YouTube Music for Eclipse &middot; v2.9.2 &middot; Cloudflare Workers</footer>
<script>
let tok=null,urls={};
function base(){return location.origin}
function generate(){
  tok=Array.from(crypto.getRandomValues(new Uint8Array(14)),b=>b.toString(16).padStart(2,'0')).join('');
  urls={both:base()+'/u/'+tok,songs:base()+'/u/'+tok+'/songs',videos:base()+'/u/'+tok+'/videos'};
  document.getElementById('urlBoth').textContent=urls.both;
  document.getElementById('urlSongs').textContent=urls.songs;
  document.getElementById('urlVideos').textContent=urls.videos;
  document.getElementById('genBox').style.display='block';
  document.getElementById('genBtn').textContent='Regenerate URLs';
}
function copyUrl(type){navigator.clipboard.writeText(urls[type])}
function checkSaved(){const v=document.getElementById('savedUrl').value.trim();document.getElementById('reCopyBtn').disabled=!v}
function reCopy(){const v=document.getElementById('savedUrl').value.trim();if(v)navigator.clipboard.writeText(v)}
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'Content-Type, Range',
        },
      });
    }

    if (env?.YT_PO_TOKEN_GENERATOR_URL && env?.UPSTASH_REDIS_REST_URL) {
      const cached = await upstashCmd(env, 'GET', 'ytm:po_token');
      if (!cached) {
        console.log(LOG_PREFIX, 'No cached PO token — requests will run without BotGuard attestation until refresh completes');
        tryRefreshPoToken(env);
      }
    } else if (!env?.YT_PO_TOKEN_GENERATOR_URL) {
      console.log(LOG_PREFIX, 'YT_PO_TOKEN_GENERATOR_URL not configured — running with no PO token support at all');
    }

    if (path === '/') return htmlRes(buildPage());

    const parsed = parseTokenPath(path);
    if (parsed) {
      if (!isValidToken(parsed.token)) return jsonRes({ error: 'Invalid token' }, 400);
      try {
        const result = await handleRoute(parsed.rest, url, request, env, parsed.token, parsed.mode);
        if (result) return result;
      } catch (e) {
        console.log(LOG_PREFIX, 'Route error:', e.message);
        return jsonRes({ error: e.message }, 500);
      }
      return jsonRes({ error: 'Not found' }, 404);
    }

    try {
      const result = await handleRoute(path, url, request, env, null, 'both');
      if (result) return result;
    } catch (e) {
      console.log(LOG_PREFIX, 'Bare route error:', e.message);
      return jsonRes({ error: e.message }, 500);
    }
    return jsonRes({ error: 'Not found' }, 404);
  },
};
