# ytm-media (VPS side)

A googlevideo URL is signed for the IP that minted it. Cloudflare Workers
rotate their egress address between subrequests, so a Worker that mints a URL
and then fetches it intermittently gets 403. This service runs on a machine with
one fixed address, so the mint and the fetch are the same connection.

    systemctl status ytm-media wg-quick@wgcf
    journalctl -u ytm-media -f
    curl -s http://127.0.0.1:8080/<secret>/health

Deployed at `/opt/ytm-media/server.mjs`, unit at `/etc/systemd/system/ytm-media.service`,
listening on `0.0.0.0:8080`. Requests must carry the secret path prefix that is
also in `MEDIA_PROXY_HOME` / `MEDIA_PROXY_VPS` in `index.js`.

## Running it on the home machine instead

Licensed art tracks — the `- Topic` uploads that are most of YouTube Music —
return `UNPLAYABLE` from every datacenter and VPN address, with or without a
signed-in cookie and with or without a PO token. A residential connection gets a
playable URL for the same request, so the Worker asks the home box first and
falls back to this VPS (which still serves ordinary video tracks) when it is off.

On the laptop, `run-local.cmd` starts the same `server.mjs` with no WARP binding
and no yt-dlp, and a tunnel publishes it:

```
cloudflared tunnel --url http://127.0.0.1:8080
```

A quick tunnel prints a fresh `*.trycloudflare.com` hostname every start, so that
hostname is a constant in `index.js` and has to be updated (or replaced by a
named tunnel on a domain) whenever the tunnel restarts. `run-local.cmd` leaves
`YTM_WARP_LOCAL_ADDR` empty, which is why `ytdlpUrl` only passes
`--source-address` when one is set.

## WARP egress

The VPS's own OVH address is flagged by YouTube: every player call comes back
`LOGIN_REQUIRED: Sign in to confirm you're not a bot`, which is what made tracks
load and then skip. So YouTube traffic goes out through Cloudflare WARP instead.

`wg-quick@wgcf` (`/etc/wireguard/wgcf.conf`) is a **split** setup: `Table = off`
plus a policy rule for source `172.16.0.2` only. The box keeps its normal route;
anything that binds that source address goes through WARP. The service binds it
for every YouTube request (`YTM_WARP_LOCAL_ADDR`), so player calls and media
fetches always leave from the same address, and the `ip=` signed into the media
URL matches the address that fetches it.

If WARP is down the service retries once on the normal route, so it degrades
instead of breaking. To go back to a direct connection, set
`Environment=YTM_WARP_LOCAL_ADDR=` (empty) in
`/etc/systemd/system/ytm-media.service.d/warp.conf`.

## Client order and the limited-URL probe

`VISIONOS` is asked first: no token, plain progressive URLs, whole file. `IOS`,
`ANDROID_VR`, `ANDROID` and `TVHTML5` follow for videos it refuses.

YouTube hands out two kinds of media URL. An ordinary one serves the whole
file. A "limited" one serves about 1 MiB and then 403s — which is what made
tracks stall halfway. Before accepting a URL the service asks for its last byte;
a real URL answers `206`, a limited one answers `403`, and a limited URL is
dropped while the next client is asked instead. Only `401/403/410` means
limited: googlevideo redirects some range requests to another backend with a
`302`, and counting that as a failure threw away perfectly good URLs.

The limited state is not permanent. When one address asks for many tracks
quickly YouTube starts answering every client with a limited URL; a round of
retries a moment later normally returns a whole-file URL, so the service runs
up to three rounds before it gives up on a track. No PO token is needed for the
clients above.

## Chunked reading (why long tracks used to be skipped)

googlevideo throttles a **single long read** from a datacenter address to a
trickle — measured here at about 0.5 KB/s, so a 50 MB track never finished and
the player skipped it after waiting. The same URL read in **2 MiB ranges** moves
at 5–9 MB/s, because each range is a fresh request.

So the body is pulled in `YTM_CHUNK_BYTES` (default 2 MiB) ranges and written
straight through to the player, with `content-length` declared up front. A 403
partway through a long track is not fatal: the URL is re-minted and the read
continues from the byte it reached, so the player's connection never breaks.

## Prewarming and video

`/stream` calls `/<secret>/prewarm/<id>` and waits for it. It returns metadata
only — `{ok, hasVideo, width, height, total, videoTotal}` — never the signed
media URL, which is bound to this address. The player then asks for `/audio/<id>`
a moment later and finds the URL already done, because both share the in-flight
map: it is the same resolve, not a second player call.

Eclipse only shows its video toggle for a track whose `/stream` reply carries a
`video` object, and it wants **one file with picture and sound** (`muxed: true`).
VISIONOS and IOS return adaptive formats only, which are video-only, so a track
that has video costs one extra player call to `ANDROID`, which still returns the
muxed 360p rendition. Tracks without video formats cost nothing extra. That
rendition is served from `/video/<id>` with its own `content-length` and range
support, taken from the probe because progressive formats omit `contentLength`.

If every client is challenged, the service falls back to `yt-dlp` (installed at
`~/.local/bin/yt-dlp`, run with `--source-address` so it also uses WARP) and
applies the same probe. That fallback is skipped when every client simply said
`UNPLAYABLE` — the track is gone, and waiting two seconds to confirm it only
delays the player's skip. Per-track URLs are memoised in RAM for five minutes so
a seek does not cost another player call; nothing is written to disk.

`YTM_COOKIE` is accepted but measured useless, and worse than useless with a
signature attached. A real signed-in session (confirmed with `account_menu`:
signed in, from both the WARP and the direct address) still gets
`UNPLAYABLE: Video unavailable` for a licensed art track, and adding the
`SAPISIDHASH` header that InnerTube expects makes the iOS/Android clients answer
`HTTP 400`. The block is the address, not the credentials.

## Unused extra

`ytm-pot` (a localhost PO-token server at `/opt/bgutil`) was used while working
out which clients need tokens. None of the clients above do, so it is installed
but stopped. `sudo systemctl start ytm-pot` brings it back if that changes.

## Removing it

    sudo systemctl disable --now ytm-media wg-quick@wgcf
    sudo rm -rf /opt/ytm-media /etc/wireguard/wgcf.conf /etc/systemd/system/ytm-media.service
    sudo rm -rf /etc/systemd/system/ytm-media.service.d
