// Offline checks for sabr.js: picking formats out of a /player reply and the
// refusal cases. No network, no Worker.
import { sabrParts, SABR_CLIENTS } from '../sabr.js';

const checks = [];
const ck = (name, cond) => checks.push([name, !!cond]);

const player = (over = {}) => ({
  streamingData: {
    serverAbrStreamingUrl: 'https://example.googlevideo.com/videoplayback?sabr=1',
    adaptiveFormats: [
      { itag: 251, lastModified: '1755900000000', mimeType: 'audio/webm; codecs="opus"', bitrate: 144964, approxDurationMs: '213000' },
      { itag: 140, lastModified: '1755900000000', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 131332, approxDurationMs: '213000', audioTrack: { audioTrackId: 'en' } },
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
ck('drops non-audio formats from the audio list', !parts?.audio.some((f) => f.itag === 137));

ck('no SABR url means no session', sabrParts(player({ streamingData: { serverAbrStreamingUrl: undefined } })) === null);
ck('no ustreamer config means no session', sabrParts({ ...player(), playerConfig: {} }) === null);
ck('audio-less reply means no session', sabrParts(player({ streamingData: { adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4', bitrate: 1 }] } })) === null);
ck('garbage reply means no session', sabrParts(undefined) === null);

ck('androidVR identity has a client number', SABR_CLIENTS.androidVR.clientName === 28);
ck('ios identity has a client number', SABR_CLIENTS.ios.clientName === 5);

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
