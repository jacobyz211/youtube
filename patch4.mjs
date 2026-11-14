import fs from 'node:fs';

const FILE = 'index.js';
let src = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

function mustReplace(from, to) {
  if (src.indexOf(from) === -1) throw new Error('not found: ' + from.slice(0, 90));
  src = src.replace(from, to);
}

// ── 1. proxyMedia: always send a Range upstream, normalise the reply ──────
const start = src.indexOf('async function proxyMedia(');
if (start === -1) throw new Error('proxyMedia not found');
const end = src.indexOf('async function proxyDownload(', start);
if (end === -1) throw new Error('proxyDownload not found');

const NEW_PROXY = `async function proxyMedia(trackId, kind, incomingRequest, env, userToken) {
  const wantsVideo = kind === 'video';
  const method = incomingRequest.method === 'HEAD' ? 'HEAD' : 'GET';
  const clientRange = incomingRequest.headers.get('range');
  // googlevideo signs these URLs with rqh=1 ("range required"): fetching one
  // without a Range header is rejected outright, which is what made a plain
  // GET — exactly what a player does first — fail with a 500. Ask for the whole
  // file explicitly instead.
  const upstreamRange = clientRange || 'bytes=0-';

  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await resolveTrack(trackId, env, userToken);
    const target = wantsVideo ? entry.video?.url : entry.url;
    if (!target) {
      if (wantsVideo) continue; // another client may expose a muxed video
      throw new Error(\`\${LOG_PREFIX} no \${kind} source for \${trackId}\`);
    }

    const headers = { ...CDN_HEADERS, Range: upstreamRange };
    if (env?.YT_COOKIE) headers.Cookie = env.YT_COOKIE;

    const upstream = await fetch(target, { method, headers });

    // 403 from the CDN means the signature was minted for a different egress
    // address than this fetch used. Mint a new one and try again.
    if (upstream.status === 403 || upstream.status === 401) {
      console.log(LOG_PREFIX, \`\${kind} \${upstream.status} for \${trackId} — re-minting URL (attempt \${attempt + 1})\`);
      continue;
    }
    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(\`\${LOG_PREFIX} CDN \${upstream.status} for \${trackId}\`);
    }

    const contentRange = upstream.headers.get('content-range') || '';
    const total = /\\/(\\d+)\\s*$/.exec(contentRange)?.[1];
    let status = upstream.status;
    let outLength = upstream.headers.get('content-length');
    let outRange = contentRange;

    // The client asked for the whole file, so answer 200 with the total length
    // rather than leaking our internal "bytes=0-" as a 206.
    if (!clientRange && status === 206) {
      status = 200;
      if (total) outLength = total;
      outRange = '';
    }

    const out = {
      'content-type': wantsVideo ? 'video/mp4' : 'audio/mp4',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'Range, If-Range, Content-Type',
      'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges',
      'cache-control': 'private, max-age=3600',
    };
    if (outLength) out['content-length'] = outLength;
    if (outRange) out['content-range'] = outRange;

    return new Response(method === 'HEAD' ? null : upstream.body, { status, headers: out });
  }
  throw new Error(\`\${LOG_PREFIX} CDN kept rejecting the signed URL for \${trackId}\`);
}

`;
src = src.slice(0, start) + NEW_PROXY + src.slice(end);

// ── 2. RAM-only memo so a seek doesn't cost another player call ──────────
const MEMO = `// ── In-RAM resolution memo ───────────────────────────────────────────────
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
`;
mustReplace('async function resolveTrack(trackId, env, userToken) {\n', MEMO);

mustReplace(
  '      const entry = await resolveStream(kind, trackId, env, userToken);\n      console.log(LOG_PREFIX, `${PLAYER_CLIENTS[kind].label} resolved ${trackId}`);\n      return entry;',
  '      const entry = await resolveStream(kind, trackId, env, userToken);\n      console.log(LOG_PREFIX, `${PLAYER_CLIENTS[kind].label} resolved ${trackId}`);\n      memoSet(trackId, entry);\n      return entry;'
);

// ── 3. version ───────────────────────────────────────────────────────────
src = src.replace("version: '2.10.2'", "version: '2.10.3'");
src = src.replace(
  '// author: ricky | version: 2.10.2 — proxied bytes, no caching',
  '// author: ricky | version: 2.10.3 — proxied bytes, Range-always upstream'
);
src = src.replace(
  '// WHAT CHANGED IN 2.10.2 — nothing is cached anymore.',
  '// WHAT CHANGED IN 2.10.3 — the CDN signs these URLs with rqh=1 (range\n' +
  '// required), so a plain GET with no Range header was rejected and surfaced as\n' +
  '// a 500. We now always send Range upstream and answer 200 + full length when\n' +
  '// the caller sent none. Resolutions are also held in isolate memory for 90s\n' +
  '// so a seek is not another player call (RAM only — nothing persisted).\n//\n' +
  '// WHAT CHANGED IN 2.10.2 — nothing is cached anymore.'
);

fs.writeFileSync(FILE, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('patched ok,', src.length, 'bytes');
