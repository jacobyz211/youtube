@echo off
rem Runs ytm-media on this laptop, so player calls and media both leave from the
rem home connection. No WARP: the tunnel address is only for the VPS.
rem
rem The secret must match MEDIA_PROXY_HOME in index.js.
set YTM_SECRET=k7f2q9w4e1r8t5y3u6i0o2p4a6s8d0g2
set YTM_WARP_LOCAL_ADDR=
set YTM_YTDLP=
set PORT=8080
node "%~dp0server.mjs"
