// Offline checks for sabr.js: format selection, refusal cases, and the byte
// range maths that makes seeking work.
import { sabrParts, parseByteRange, serveAudioBytes, SABR_CLIENTS } from '../sabr.js';

const checks = [];
const ck = (name, cond) => checks.push([name, !!cond]);

const player = (over = {}) => ({
  streamingData: {
    serverAbrStreamingUrl: 'https://example.googlevideo.com/videoplayback?sabr=1',
    adaptiveFormats: [
      { itag: 251, lastModified: '1755900000000', mimeType: 'audio/webm; codecs="opus"', bitrate: 144964, approxDurationMs: '213000', contentLength: 3450000 },
      { itag: 140, lastModified: '1755900000000', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 131332, approxDurationMs: '213000', audioTrack: { audioTrackId: 'en' }, contentLength: 3449447 },
      { itag: 137, lastModified: '1755900000000', mimeType: 'video/mp4; codecs="avc1"', bitrate: 4000000 },
    ],
    ...(over.streamingData || {}),
  },
  playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: 'CgA=' } } },
  ...over,
});

const parts = sabrParts(player());
ck('reads the SABR url', parts?.url?.includes('sabr=1'));
ck('keeps audio only', parts?.audio.length === 2);
ck('prefers AAC/MP4 over higher-bitrate Opus', parts?.audio[0].itag === 140);
ck('lastModified stays the epoch-millis string', parts?.formats[0].lastModified === '1755900000000');
ck('carries the audio track id', parts?.formats.find((f) => f.itag === 140).audioTrackId === 'en');
ck('keeps content length', parts?.audio[0].contentLength === 3449447);
ck('drops non-audio formats from the audio list', !parts?.audio.some((f) => f.itag === 137));
ck('no SABR url means no session', sabrParts(player({ streamingData: { serverAbrStreamingUrl: undefined } })) === null);
ck('no ustreamer config means no session', sabrParts({ ...player(), playerConfig: {} }) === null);
ck('audio-less reply means no session', sabrParts(player({ streamingData: { adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4', bitrate: 1 }] } })) === null);
ck('garbage reply means no session', sabrParts(undefined) === null);

const TOTAL = 1000;
ck('no header means whole file', parseByteRange(null, TOTAL) === null);
ck('open-ended range runs to the end', JSON.stringify(parseByteRange('bytes=100-', TOTAL)) === JSON.stringify({ start: 100, end: 999 }));
ck('closed range is exact', JSON.stringify(parseByteRange('bytes=100-199', TOTAL)) === JSON.stringify({ start: 100, end: 199 }));
ck('end past EOF is clamped', parseByteRange('bytes=900-5000', TOTAL).end === 999);
ck('suffix range counts back from the end', JSON.stringify(parseByteRange('bytes=-100', TOTAL)) === JSON.stringify({ start: 900, end: 999 }));
ck('start past EOF is refused', parseByteRange('bytes=1000-', TOTAL) === null);
ck('nonsense header is refused', parseByteRange('bytes=abc', TOTAL) === null);

const bytes = new Uint8Array(1000).map((_, i) => i % 251);
const full = serveAudioBytes({ bytes, contentType: 'audio/mp4' });
ck('full response is 200', full.status === 200);
ck('full response advertises ranges', full.headers.get('accept-ranges') === 'bytes');
ck('full response carries a length', full.headers.get('content-length') === '1000');
const ranged = serveAudioBytes({ bytes, contentType: 'audio/mp4', range: { start: 100, end: 199 } });
ck('range response is 206', ranged.status === 206);
ck('range response reports content-range', ranged.headers.get('content-range') === 'bytes 100-199/1000');
ck('range response length is the slice', ranged.headers.get('content-length') === '100');
const head = serveAudioBytes({ bytes, contentType: 'audio/mp4', range: { start: 0, end: 9 }, head: true });
ck('HEAD answers headers without a body', head.body === null && head.status === 206);

ck('androidVR identity has a client number', SABR_CLIENTS.androidVR.clientName === 28);
ck('ios identity has a client number', SABR_CLIENTS.ios.clientName === 5);

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
