// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 2.15.0 — stable home endpoint
//
// WHAT CHANGED IN 2.15.0 — the home box is reached over an SSH reverse tunnel on
// this VPS (port 8081) instead of a Cloudflare quick tunnel, so its address is
// permanent and a reboot needs no edit. The circuit breaker that parked the home
// box for a minute after one dropped connection is gone: since only the home box
// can resolve a licensed art track, that pinned every song into a blackout.
//
// WHAT CHANGED IN 2.14.0 — licensed art tracks (the "- Topic" uploads that are
// almost every song in YouTube Music) answer UNPLAYABLE from every address this
// Worker's helpers could reach: Cloudflare, the VPS's own OVH IP, Cloudflare
// WARP, and ten different client identities. A signed-in cookie did not help
// (the session was verified as signed in), and neither did PO tokens. The same
// request from a residential connection returns a playable URL, so media now
// goes through a proxy on the home network over a Cloudflare tunnel, with the
// VPS kept as the fallback for when that machine is asleep.
//
// WHAT CHANGED IN 2.13.0 — /stream never advertised a video, so Eclipse had no
// toggle to offer and the /video route was never called. It now sends the
// `video` object the docs describe, pointing at a single muxed file, and waits
// for the proxy's prewarm so that object (and the playback URL) is ready before
// the app asks for bytes.
//
// WHAT CHANGED IN 2.12.0 — the proxy throttles a single long read, so long
// tracks stalled and were skipped. /stream now also asks the proxy to resolve
// the track in the background, so the player call is already done by the time
// the player asks for bytes. See vps/server.mjs.
//
// WHAT CHANGED IN 2.11.0 — the bytes are fetched by a one-file proxy on a VPS
// with a fixed address, because Cloudflare rotates egress IPs between the mint
// and the fetch and the signature is bound to the minting address. /stream no
// longer resolves anything, so a track costs one player call instead of three.
//
// WHAT CHANGED IN 2.10.3 — the CDN signs these URLs with rqh=1 (range
// required), so a plain GET with no Range header was rejected and surfaced as
// a 500. We now always send Range upstream and answer 200 + full length when
// the caller sent none. Resolutions are also held in isolate memory for 90s
// so a seek is not another player call (RAM only — nothing persisted).
//
// WHAT CHANGED IN 2.10.2 — nothing is cached anymore. 2.10.1 (below) is the
// change that actually made playback possible.
//
// WHAT CHANGED IN 2.10.1 — the actual cause of "no playback"
// - A googlevideo URL is signed for the IP address that asked for it: `ip` is
//   in the URL's sparams list and is covered by the signature. Rewriting the
//   ip= parameter and re-fetching returns 403 text/plain (verified).
// - So the old /stream handed Eclipse a URL minted for the WORKER's Cloudflare
//   IP, while the phone fetched it from the phone's IP. Different IP, invalid
//   signature, 403 — playback could never work no matter which client resolved
//   the track or how many times the fallback chain ran.
// - /stream now returns a URL on this Worker (/audio/<id>), and the Worker is
//   both the minter and the fetcher, so the bound IP always matches. The same
//   applies to the optional video (/video/<id>).
// - Because Cloudflare may egress a second request through a different
//   address, a 403 from the CDN is treated as "signature/IP mismatch": the
//   cached URL is dropped, the track is re-resolved once, and the fetch is
//   retried. A persistent 403 still surfaces as an error instead of silence.
// - The stream reply now also carries the routing fields Eclipse uses to pick
//   a playback engine before the first byte (codec/container/manifest/
//   expiresAt), so the client doesn't have to probe the file.
// - Nothing is cached. Every request resolves fresh; no track, URL or audio
//   byte is stored anywhere. The tradeoff is one player call per audio
//   request instead of one per track.
//
// WHAT CHANGED IN 2.10.0 (and why the "10 bot errors per stream" are gone)
// - The /stream chain is now 3 clients, not 9. Live probing showed that 7 of
//   the 10 client identities this addon was trying no longer return streaming
//   data at ALL — they fail with dead-client errors, not bot checks:
//     WEB / WEB_REMIX / MWEB / TVHTML5  -> UNPLAYABLE "The page needs to be reloaded."
//     TVHTML5_SIMPLY_EMBEDDED_PLAYER    -> ERROR "YouTube is no longer supported in this application or device."
//     WEB_EMBEDDED_PLAYER               -> ERROR "This video is unavailable"
//     WEB_CREATOR / ANDROID_MUSIC       -> LOGIN_REQUIRED "Please sign in"
//   Those attempts were the ~10 error lines per stream in `wrangler tail`:
//   one genuine failure fanned out into 8 more player calls, plus 3 more from
//   the old fetchVideoInfo() best-effort video probe.
// - (2.10.0 briefly cached resolved URLs; that cache was removed in 2.10.2 on
//   request — nothing is stored now, every request resolves fresh.)
// - Video is derived from the same player response that resolved the audio,
//   so the extra player calls fetchVideoInfo() used to make are gone.
// - A client that answers with a bot check is skipped for 2 minutes instead of
//   being hammered again on the next stream request.
// - PO-token plumbing removed. YouTube binds PO tokens to a single video ID and
//   only WEB/WEB_EMBEDDED read serviceIntegrityDimensions.poToken, so the old
//   global 6-hour token attached to every Android/iOS call could never be
//   valid — and a stale token on a mismatched client is itself a tamper signal.
//   None of the three working clients consume a PO token.
// - visitorData cache TTL 5 min -> 6 h (less artificial churn).
//
// History (2.9.x): repeated attempts to cure LOGIN_REQUIRED by adding more
// client identities. That cannot work when the identities themselves are dead.
// The chain now contains only clients verified to resolve.
const LOG_PREFIX = '[YTMusic]';

const YTM_BASE = 'https://music.youtube.com';
const YTM_API_KEY_FALLBACK = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
function getApiKey(env) { return env?.YTM_API_KEY || YTM_API_KEY_FALLBACK; }

const VISITOR_TTL_SEC = 21600;
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
// The WEB / MWEB / WEB_CREATOR / WEB_EMBEDDED_PLAYER / TVHTML5 /
// TVHTML5_SIMPLY_EMBEDDED_PLAYER client definitions that used to live here were
// removed in 2.10.0: they are dead identities that can never resolve, and every
// call spent on them is one more flagged request from this Worker's IP.
// ANDROID_MUSIC_CLIENT stays — it is dead for /player but still valid for
// /search and /browse, which is what the search backfill uses it for.

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

// PO-token helpers were removed in 2.10.0. See the header note: tokens are
// bound to a single video ID and only the WEB-family clients read them, and all
// of those clients are dead. YT_PO_TOKEN / YT_VISITOR_DATA /
// YT_PO_TOKEN_GENERATOR_URL are no longer read.
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
      headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_MUSIC_UA },
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
    headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_MUSIC_UA },
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
// ═══════════════════════════════════════════════════════════════════════
// ── PLAYER & STREAMING ─────────────────────────────────────────────────
// Three client identities are tried, in this order, and only these three:
//   android   -> the YT Music / YT app identity: direct AAC (itag 140) plus a
//                progressive mp4 for the optional video field.
//   androidvr -> Quest headset identity: a genuinely different fingerprint
//                family, used when the Android identity gets checked.
//   ios       -> HLS manifest (works even when progressive formats are absent).
// Measured 2026-11-13: all three return status=OK with no visitorData, no
// cookie and no PO token. The other seven identities in the old chain returned
// UNPLAYABLE / ERROR / LOGIN_REQUIRED unconditionally.
// ═══════════════════════════════════════════════════════════════════════
class PlayerError extends Error {
  constructor(message, botBlocked) {
    super(message);
    this.name = 'PlayerError';
    this.botBlocked = !!botBlocked;
  }
}

const PLAYER_CLIENTS = {
  android: {
    label: 'ANDROID',
    client: () => ANDROID_NATIVE_CLIENT,
    ua: ANDROID_NATIVE_UA,
    headers: { 'X-Goog-Api-Format-Version': '2' },
  },
  androidvr: {
    label: 'ANDROID_VR',
    client: () => ANDROID_VR_CLIENT,
    ua: ANDROID_VR_UA,
    headers: { 'X-Goog-Api-Format-Version': '2' },
  },
  ios: {
    label: 'IOS',
    client: () => IOS_CLIENT_BASE,
    ua: IOS_UA,
    headers: {},
  },
};

// One player request, parameterised by client. Replaces the nine near-identical
// fetchPlayerData* functions the addon used to carry.
async function playerRequest(kind, trackId, env, userToken) {
  const spec = PLAYER_CLIENTS[kind];
  if (!spec) throw new Error(`unknown player client ${kind}`);
  const visitorData = await getVisitorData(env, userToken);
  const client = {};
  for (const [k, v] of Object.entries(spec.client())) client[k] = v;
  if (visitorData) client.visitorData = visitorData;

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': spec.ua,
    ...spec.headers,
  };
  if (env?.YT_COOKIE) headers.Cookie = env.YT_COOKIE;

  const body = { context: { client }, videoId: trackId, contentCheckOk: true, racyCheckOk: true };
  const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new PlayerError(`${spec.label} HTTP ${resp.status}`, resp.status === 403 || resp.status === 429);
  }
  const data = await resp.json();
  const ps = data?.playabilityStatus || {};
  if (ps.status !== 'OK') {
    const detail = `${ps.status || 'UNKNOWN'}${ps.reason ? ': ' + ps.reason : ''}`;
    // Only anti-bot / auth refusals cool the client down. A deleted or
    // region-locked video ("This video is unavailable") is a property of that
    // video, not of the client, and must not park the client for other tracks.
    const botBlocked = /bot|sign in|rate limit|too many/i.test(ps.reason || '') ||
      (ps.status === 'LOGIN_REQUIRED' && !ps.reason);
    throw new PlayerError(`${spec.label} ${detail}`, botBlocked);
  }
  return data;
}

// A client that just answered with a bot check is parked for two minutes.
// Retrying it on the very next request is what turns one block into a storm.
const CLIENT_COOLDOWN_MS = 120000;
const blockedClients = new Map();
function clientCoolingDown(label) {
  const until = blockedClients.get(label);
  if (!until) return false;
  if (Date.now() >= until) { blockedClients.delete(label); return false; }
  return true;
}
function coolDownClient(label) {
  blockedClients.set(label, Date.now() + CLIENT_COOLDOWN_MS);
}

function pickBestAudio(sd) {
  return (sd?.adaptiveFormats || [])
    .filter(f => f.mimeType?.startsWith('audio/mp4') && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null;
}

// ── Video support (eclipsemusic.app/docs "Video Playback") ──────────────
// Built from the SAME player response that resolved the audio, so it costs no
// extra requests. Legacy itag 17 (144p 3GP) is rejected — it is what showed up
// as a tiny squished video.
const MIN_VIDEO_HEIGHT = 240;
function pickVideoRenditions(sd) {
  return (sd?.formats || [])
    .filter(f => f.url && f.mimeType?.startsWith('video/mp4') &&
      f.mimeType.includes('mp4a') && (f.height || 0) >= MIN_VIDEO_HEIGHT)
    .map(f => ({ url: f.url, height: f.height, width: f.width || 0, mimeType: 'video/mp4' }))
    .sort((a, b) => b.height - a.height);
}
function buildVideoInfo(sd) {
  const renditions = pickVideoRenditions(sd);
  if (!renditions.length) return null;
  const best = renditions[0];
  return { url: best.url, mimeType: 'video/mp4', muxed: true, width: best.width || 0, height: best.height, renditions };
}

// NO CACHING. Every /stream and every /audio request resolves the track
// fresh against YouTube. The only thing kept between requests is the visitor
// ID (see getVisitorData), which is an anonymous session identifier, not
// track data.
//
// Note on cost: a googlevideo URL is signed for the IP that minted it, so the
// Worker has to mint one for itself before it can fetch the bytes. Without a
// cache that means one player call per audio request (and per seek, since a
// seek is another Range request).

function urlExpirySeconds(url) {
  const m = /[?&]expire=(\d+)/.exec(url || '');
  return m ? parseInt(m[1], 10) : Math.floor(Date.now() / 1000) + 3600;
}

async function resolveStream(kind, trackId, env, userToken) {
  const data = await playerRequest(kind, trackId, env, userToken);
  const sd = data?.streamingData || {};
  const video = buildVideoInfo(sd);
  const best = pickBestAudio(sd);
  const url = best?.url || sd.hlsManifestUrl;
  if (!url) throw new PlayerError(`${PLAYER_CLIENTS[kind].label}: no usable format`);
  return {
    url,
    format: best ? 'm4a' : 'hls',
    quality: best ? 'native' : 'auto',
    expiresAt: urlExpirySeconds(url),
    video: video || null,
  };
}

// Try the live clients in order, honouring the bot cooldown.
// ── In-RAM resolution memo ───────────────────────────────────────────────
// Deliberately NOT a cache: nothing is written to Redis, KV, D1 or disk. These
// entries exist only inside this isolate's memory and vanish with it. The point
// is that a seek (one more Range request on the same track) doesn't turn into
// another player call.
const MEMO_TTL_MS = 90 * 1000;
const MEMO_MAX = 40;
const memo = new Map();

function memoGet(id) {
  const hit = memo.get(id);
  if (!hit) return null;
  if (hit.expires < Date.now()) { memo.delete(id); return null; }
  return hit.entry;
}

function memoSet(id, entry) {
  const urlExpiry = entry.expiresAt ? entry.expiresAt * 1000 - 30000 : Infinity;
  const expires = Math.min(Date.now() + MEMO_TTL_MS, urlExpiry);
  if (expires <= Date.now()) return;
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(id, { entry, expires });
}

async function resolveTrack(trackId, env, userToken) {
  const memoHit = memoGet(trackId);
  if (memoHit) return memoHit;
  const kinds = ['android', 'androidvr', 'ios'];
  const available = kinds.filter(k => !clientCoolingDown(PLAYER_CLIENTS[k].label));
  const order = available.length ? available : kinds;

  let lastError = null;
  for (let i = 0; i < order.length; i++) {
    const kind = order[i];
    // Small randomized gap between attempts only. Firing back-to-back player
    // calls from one Worker IP with no spacing is itself a machine pattern.
    if (i > 0) await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
    try {
      const entry = await resolveStream(kind, trackId, env, userToken);
      console.log(LOG_PREFIX, `${PLAYER_CLIENTS[kind].label} resolved ${trackId}`);
      memoSet(trackId, entry);
      return entry;
    } catch (e) {
      lastError = e;
      if (e.botBlocked) {
        coolDownClient(PLAYER_CLIENTS[kind].label);
        console.log(LOG_PREFIX, `${PLAYER_CLIENTS[kind].label} bot-checked, cooling down 2m`);
      }
      console.log(LOG_PREFIX, `${PLAYER_CLIENTS[kind].label} failed for ${trackId}: ${e.message}`);
    }
  }
  throw new Error(`${LOG_PREFIX} No playable audio for ${trackId}${lastError ? ' — ' + lastError.message : ''}`);
}

// ── /stream reply ───────────────────────────────────────────────────────
// IMPORTANT: the CDN URL is signed for the IP that minted it (sparams includes
// ip, and the signature covers it), so handing it to a listener's phone yields
// 403. Both audio and video are therefore served from this Worker instead.
// No player call here. Eclipse asks for /stream immediately before it asks for
// the media URL, and the media URL is resolved by the proxy anyway; resolving in
// both places doubled the request volume for no benefit and is what tripped
// YouTube's "confirm you're not a bot" challenge.
const STREAM_TTL_SEC = 6 * 3600;

function buildStreamResponse(trackId, origin, meta) {
  const base = (origin || '').replace(/\/+$/, '');
  const out = {
    url: `${base}/audio/${trackId}`,
    format: 'm4a',
    quality: 'native',
    codec: 'aac',
    container: 'mp4',
    // Routing fields: tell the app the bytes are a plain file, so it picks a
    // playback engine before the first byte instead of probing.
    manifest: 'none',
    encrypted: false,
    expiresAt: Math.floor(Date.now() / 1000) + STREAM_TTL_SEC,
  };
  // Eclipse only shows its video toggle when /stream offers a video. The proxy
  // hands back one file that carries both picture and sound, which is what
  // `muxed: true` means — that plays on every platform.
  if (meta && meta.hasVideo) {
    out.video = {
      url: `${base}/video/${trackId}`,
      mimeType: 'video/mp4',
      muxed: true,
    };
    if (meta.width) out.video.width = meta.width;
    if (meta.height) out.video.height = meta.height;
  }
  return out;
}

// Asks the proxy to resolve now and waits for the answer, so the player call is
// finished before the app asks for bytes, and so this reply can advertise the
// video rendition. A track that fails comes back without meta and /audio then
// reports the real error.
async function warmTrack(trackId) {
  for (const base of mediaProxyOrder()) {
    try {
      const res = await fetch(`${base}/prewarm/${encodeURIComponent(trackId)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const meta = await res.json().catch(() => null);
      if (meta && meta.ok === false) return null;
      return meta && meta.ok ? meta : null;
    } catch {
      // Try the next box.
    }
  }
  return null;
}

async function handleStream(trackId, env, userToken, origin) {
  return buildStreamResponse(trackId, origin, await warmTrack(trackId));
}

// ── Media proxy ─────────────────────────────────────────────────────────
// Fetches the bytes with the same Worker that minted the URL, so the ip= in
// the signature always matches the connection that opens it.
const CDN_HEADERS = {
  'User-Agent': ANDROID_NATIVE_UA,
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://music.youtube.com',
  'Referer': 'https://music.youtube.com/',
};

// The bytes are fetched by a single-IP box, not by this Worker. googlevideo
// signs a URL for the address that minted it, and Cloudflare rotates its egress
// address between subrequests, so minting and fetching from here intermittently
// 403s. One machine doing both is the only way this is reliably correct.
//
// Two boxes, tried in order. The laptop at home is first because licensed art
// tracks answer UNPLAYABLE from every datacenter and VPN address, and only a
// residential connection gets a playable URL — proven by testing the same
// request from the home connection and from the VPS. The VPS stays second: it
// still resolves ordinary video tracks, so a laptop that is asleep degrades to
// yesterday's behaviour instead of breaking playback outright.
// Port 8081 on this same box is an SSH reverse tunnel to the laptop (the laptop
// runs `ssh -R 0.0.0.0:8081:127.0.0.1:8080`), so this address never changes and
// nothing has to be edited when the machine reboots. When the laptop is off the
// forwarded port disappears with the SSH session, so the request fails in
// milliseconds instead of hanging. A quick tunnel was tried first and rejected:
// its hostname changes on every restart and it drops connections often enough to
// make playback flaky.
const MEDIA_PROXY_HOME = 'http://15-204-247-1.sslip.io:8081/k7f2q9w4e1r8t5y3u6i0o2p4a6s8d0g2';
const MEDIA_PROXY_VPS = 'http://15-204-247-1.sslip.io:8080/k7f2q9w4e1r8t5y3u6i0o2p4a6s8d0g2';

// No circuit breaker here on purpose. One was tried and it was the bug: a single
// dropped tunnel connection parked the home box for a minute, and since only the
// home box can resolve a licensed art track, every song in the app then failed
// with nothing to retry against. A dead tunnel refuses the connection in
// milliseconds, which is cheap enough to pay on every request.
function mediaProxyOrder() {
  return [MEDIA_PROXY_HOME, MEDIA_PROXY_VPS];
}

async function proxyMedia(trackId, kind, incomingRequest, env, userToken) {
  const method = incomingRequest.method === 'HEAD' ? 'HEAD' : 'GET';
  const clientRange = incomingRequest.headers.get('range');

  let upstream = null;
  let failure = null;
  for (const base of mediaProxyOrder()) {
    try {
      // Deliberately no timeout: this fetch is the audio stream itself, and an
      // abort signal would cut playback off mid-track.
      const res = await fetch(`${base}/${kind}/${encodeURIComponent(trackId)}`, {
        method,
        headers: clientRange ? { range: clientRange } : {},
      });
      if (res.ok || res.status === 206) {
        upstream = res;
        break;
      }
      // This box answered but cannot serve the track; ask the other one before
      // giving up, since only home can serve a licensed art track.
      failure = res;
    } catch (e) {
      failure = failure || e;
    }
  }

  if (!upstream) {
    if (failure instanceof Response) {
      const detail = await failure.text().catch(() => '');
      throw new Error(`${LOG_PREFIX} media ${failure.status} for ${trackId}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
    }
    throw new Error(`${LOG_PREFIX} media proxy unreachable for ${trackId}${failure ? ' — ' + String(failure.message || failure) : ''}`);
  }

  let status = upstream.status;
  let length = upstream.headers.get('content-length');
  let contentRange = upstream.headers.get('content-range') || '';

  // No Range was asked for, so present the whole file as 200 rather than
  // leaking the proxy's internal "bytes=0-" as a 206.
  if (!clientRange && status === 206) {
    status = 200;
    const total = /\/(\d+)\s*$/.exec(contentRange)?.[1];
    if (total) length = total;
    contentRange = '';
  }

  const out = {
    'content-type': kind === 'video' ? 'video/mp4' : 'audio/mp4',
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Range, If-Range, Content-Type',
    'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges',
    // No stored copy on the device either: a truncated first attempt must never
    // be what the player keeps replaying, and the bytes are cheap to re-pull.
    'cache-control': 'no-store',
  };
  if (length) out['content-length'] = length;
  if (contentRange) out['content-range'] = contentRange;

  return new Response(method === 'HEAD' ? null : upstream.body, { status, headers: out });
}

async function proxyDownload(trackId, incomingRequest, env, userToken) {
  const res = await proxyMedia(trackId, 'audio', incomingRequest, env, userToken);
  const headers = new Headers(res.headers);
  headers.set('content-disposition', `attachment; filename="${trackId}.m4a"`);
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
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
    id: v.id, name: v.name, version: '2.15.0', description: v.description,
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
async function handleRoute(rest, url, request, env, userToken, mode, ctx) {
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
  const ECLIPSE_GATED_PREFIXES = ["/search", "/stream", "/download", "/album", "/artist", "/playlist"];
if (ECLIPSE_GATED_PREFIXES.some((p) => rest === p || rest.startsWith(p + "/"))) {
  const eclipseClaims = await checkEclipseAccess(request);
  if (!eclipseClaims) return eclipseAccessDeniedResponse();
}
  if (rest === '/search') return jsonRes(await handleSearch(q, env, userToken, effectiveMode));
  if (rest.startsWith('/stream/')) {
    const id = lastSegment(rest);
    if (!id) return jsonRes({ error: 'Missing ID' }, 400);
    // YouTube takes 0.4–3 s to hand back a playable URL, and the player asks for
    // the bytes the instant this reply lands. Resolving it here (same in-RAM
    // entry, so it is not a second player call) is what makes pressing play feel
    // immediate, and it is also how the video rendition gets advertised.
    return jsonRes(await handleStream(id, env, userToken, env?.PUBLIC_BASE_URL || url.origin));
  }
  // Media bytes are served by this Worker, not by googlevideo: the signed CDN
  // URL is only valid from the IP that minted it. These two are deliberately
  // not behind the Eclipse gate — a player fetching an audio URL does not send
  // the addon's access header.
  if (rest.startsWith('/audio/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing ID' }, 400); return await proxyMedia(id, 'audio', request, env, userToken); }
  if (rest.startsWith('/video/')) { const id = lastSegment(rest); if (!id) return jsonRes({ error: 'Missing ID' }, 400); return await proxyMedia(id, 'video', request, env, userToken); }
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
  async fetch(request, env, ctx) {
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

    // 2.10.0: no PO-token warmup here anymore — the working clients don't use
    // PO tokens and the WEB-family clients that did are dead. Making an extra
    // request on every single call was pure overhead.

    if (path === '/') return htmlRes(buildPage());

    const parsed = parseTokenPath(path);
    if (parsed) {
      if (!isValidToken(parsed.token)) return jsonRes({ error: 'Invalid token' }, 400);
      try {
        const result = await handleRoute(parsed.rest, url, request, env, parsed.token, parsed.mode, ctx);
        if (result) return result;
      } catch (e) {
        console.log(LOG_PREFIX, 'Route error:', e.message);
        return jsonRes({ error: e.message }, 500);
      }
      return jsonRes({ error: 'Not found' }, 404);
    }

    try {
      const result = await handleRoute(path, url, request, env, null, 'both', ctx);
      if (result) return result;
    } catch (e) {
      console.log(LOG_PREFIX, 'Bare route error:', e.message);
      return jsonRes({ error: e.message }, 500);
    }
    return jsonRes({ error: 'Not found' }, 404);
  },
};
