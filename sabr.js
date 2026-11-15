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
// Output is a plain audio stream the player can consume, so this only ever
// replaces a URL — never the reply shape.

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

/**
 * Start an audio-only SABR session.
 *
 * `mintPoToken` is optional: it is called if the server asks for an
 * attestation mid-stream, and must resolve to the raw token bytes. Without a
 * generator wired up the session still runs for content that does not need
 * one — which, measured, is most of it.
 */
export function openSabrAudio({ data, videoId, clientInfo, mintPoToken }) {
  const parts = sabrParts(data);
  if (!parts) return null;
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
  const best = parts.audio[0];
  const { audioStream } = stream.start({
    audioFormat: best.itag,
    enabledTrackTypes: 1, // AUDIO_ONLY — video is a separate lookup in this addon
    isPostLiveDvr: false,
  });
  return {
    stream,
    audioStream,
    itag: best.itag,
    contentType: best.mimeType.startsWith('audio/webm') ? 'audio/webm' : 'audio/mp4',
  };
}

/**
 * Wrap a SABR audio stream in a Response the player can consume.
 *
 * A SABR session has no byte offsets to satisfy a Range header with, so the
 * body always starts at zero and `accept-ranges: none` says so honestly —
 * players then stream from the first byte instead of probing for a length that
 * does not exist yet. That is the one compromise versus a cached file, and this
 * path only runs when every direct URL failed.
 */
export function sabrResponse({ audioStream, stream, contentType }) {
  const reader = audioStream.getReader();
  const body = new ReadableStream({
    start(controller) {
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch {}
        }
      })();
    },
    async cancel() {
      try { await reader.cancel(); } catch {}
      try { await stream.abort(); } catch {}
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-expose-headers': 'content-type',
      'cache-control': 'no-store',
      'accept-ranges': 'none',
    },
  });
}
