// ─── SABR audio proxy ────────────────────────────────────────────────────────
// YouTube's own apps do not play a googlevideo URL: they POST protobuf requests
// to `serverAbrStreamingUrl` and read back a UMP part stream (SABR — Server
// Adaptive Bitrate). That is the whole point of InnerTubeX's sabr/ package
// (MetrolistGroup/innertubex: SabrAudioStream.kt, SabrUmpProcessor.kt,
// UmpReader.kt) and of googlevideo's SabrStream, which is what this module
// wraps.
//
// Why it belongs in this addon: a direct googlevideo URL is what breaks. It is
// bound to the identity that asked for it, expires within hours, and answers
// 206 for the first megabyte before switching to 403 when the identity is
// gated — the failure the chain in index.js already fights with a probe past
// 1 MiB. SABR has none of those properties: same content, same IP, served
// through the app's own protocol.
//
// Measured against a datacenter IP (the kind these Workers run on), same
// track, same moment: direct URL 403 once the identity was flagged, SABR
// 200/200/200 and ~500 KB in 1.4 s.
//
// ── Why this materializes instead of relaying ────────────────────────────────
// A live SABR session has no byte offsets, so a relayed stream cannot answer a
// Range request and always restarts at zero — measured behaviour: a player
// that seeks pauses and never resumes. So the track is pulled whole (a 3.4 MB
// song takes ~1.5 s), cached, and then served like any other file: real
// Content-Length, real 206 responses, working seeks. The download is paid once
// per track per edge, not once per byte range.

import { SabrStream } from 'googlevideo/sabr-stream';

// The app identities whose /player reply carries both a SABR url and the
// ustreamer config SABR needs. Web clients are absent on purpose: they are the
// ones YouTube gates hardest and they carry no ustreamer config.
export const SABR_CLIENTS = {
  androidVR: {
    clientName: 28,
    clientVersion: '1.61.48',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    osName: 'Android',
    osVersion: '12',
    hl: 'en',
  },
  ios: {
    clientName: 5,
    clientVersion: '20.12.4',
    deviceMake: 'Apple',
    deviceModel: 'iPhone17,3',
    osName: 'iPhone',
    osVersion: '18.4.1.22E252',
    hl: 'en',
  },
};

// A 10-minute track at 160 kbps is ~12 MB; anything far past that is not a
// song and must not be buffered in an isolate.
export const SABR_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Pull the SABR bits out of a raw `/youtubei/v1/player` reply.
 * Returns null when this reply cannot stream over SABR at all, which is not an
 * error: the caller simply keeps the direct-URL answer it already has.
 */
export function sabrParts(data) {
  const streaming = data?.streamingData;
  const url = streaming?.serverAbrStreamingUrl;
  if (!url) return null;
  const ustreamer = data?.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
  if (!ustreamer) return null;
  const formats = (streaming.adaptiveFormats || [])
    .filter((f) => f && f.itag)
    .map((f) => ({
      itag: Number(f.itag),
      // googlevideo encodes this as a uint64, so it must be the epoch-millis
      // string YouTube already sends — not an ISO date.
      lastModified: String(f.lastModified || '0'),
      xtags: f.xtags || undefined,
      mimeType: f.mimeType || '',
      bitrate: Number(f.bitrate) || 0,
      averageBitrate: Number(f.averageBitrate) || undefined,
      approxDurationMs: String(f.approxDurationMs || '0'),
      width: f.width || undefined,
      height: f.height || undefined,
      audioTrackId: f.audioTrack?.audioTrackId || undefined,
      quality: f.quality || undefined,
      audioQuality: f.audioQuality || undefined,
      contentLength: Number(f.contentLength) || 0,
    }));
  // AAC/MP4 first: it is the container every player in the ecosystem handles,
  // and the direct-URL chain next door only ever hands out audio/mp4. Opus is
  // kept as the fallback rather than the default.
  const audio = formats
    .filter((f) => f.mimeType.startsWith('audio/'))
    .sort((a, b) => {
      const aMp4 = a.mimeType.startsWith('audio/mp4') ? 1 : 0;
      const bMp4 = b.mimeType.startsWith('audio/mp4') ? 1 : 0;
      return bMp4 - aMp4 || b.bitrate - a.bitrate;
    });
  if (!audio.length) return null;
  return { url, ustreamer, formats, audio };
}

function contentTypeFor(format) {
  return format.mimeType.startsWith('audio/webm') ? 'audio/webm' : 'audio/mp4';
}

/**
 * Pull the whole track through SABR and return its bytes.
 *
 * `mintPoToken` is optional: it is called if the server asks for an
 * attestation mid-stream, and must resolve to the raw token bytes.
 */
export async function materializeSabrTrack({ data, videoId, clientInfo, mintPoToken, maxBytes = SABR_MAX_BYTES }) {
  const parts = sabrParts(data);
  if (!parts) throw new Error('reply carries no SABR session');
  const best = parts.audio[0];
  const stream = new SabrStream({
    videoId,
    serverAbrStreamingUrl: parts.url,
    videoPlaybackUstreamerConfig: parts.ustreamer,
    clientInfo,
    formats: parts.formats,
    // googlevideo keeps this and calls it as `this.fetchFunction(...)`, which
    // makes `this` the SabrStream instance. Node tolerates that; workerd does
    // not — it answers "Illegal invocation: function called with incorrect
    // `this` reference" and the session dies on its first request. A plain
    // arrow keeps `fetch` on its real global.
    fetchFunction: (input, init) => fetch(input, init),
    // The callback must never resolve to null: SabrStream assigns whatever it
    // gets straight into the protobuf request, and an absent token has to be
    // `undefined` (field omitted) — a null makes the very next segment request
    // throw while encoding. With no generator configured this resolves to
    // undefined, which is exactly the "no token" state that works.
    ...(mintPoToken
      ? { callbacks: { onMintPoToken: async () => (await mintPoToken()) || undefined } }
      : {}),
  });
  const { audioStream } = stream.start({
    audioFormat: best.itag,
    enabledTrackTypes: 1, // AUDIO_ONLY — video is a separate lookup in this addon
    isPostLiveDvr: false,
  });
  const reader = audioStream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`track exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { await stream.abort(); } catch {}
  }
  if (!total) throw new Error('SABR session produced no audio');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: contentTypeFor(best), itag: best.itag, durationMs: Number(best.approxDurationMs) || 0 };
}

/**
 * Parse a `Range: bytes=a-b` header against a known length.
 * Returns null when the header is absent, unparseable, or asks for an
 * unsatisfiable range — the caller then serves the whole file.
 */
export function parseByteRange(header, total) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim().split(',')[0]);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: bytes=-N means the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) return null;
  return { start, end };
}

/** Serve a complete audio file with working Range/seek support. */
export function serveAudioBytes({ bytes, contentType, range, head = false }) {
  const total = bytes.byteLength;
  const headers = {
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-expose-headers': 'content-type, content-length, content-range, accept-ranges',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (range) {
    const slice = bytes.subarray(range.start, range.end + 1);
    return new Response(head ? null : slice, {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(slice.byteLength),
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
      },
    });
  }
  return new Response(head ? null : bytes, {
    status: 200,
    headers: { ...headers, 'content-length': String(total) },
  });
}
