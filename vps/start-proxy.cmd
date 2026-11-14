@echo off
rem Click this to start playback support on this laptop: the media proxy plus the
rem SSH reverse tunnel that gives it a permanent address on the VPS.
rem Nothing here starts automatically at login — that is deliberate.
setlocal

set YTM_SECRET=k7f2q9w4e1r8t5y3u6i0o2p4a6s8d0g2
set YTM_WARP_LOCAL_ADDR=
set YTM_YTDLP=
set PORT=8080

rem Keep a log next to this script: when a track will not start, the question is
rem whether the app ever asked for the bytes, and only the log can answer it.
if exist "%~dp0proxy.log" for %%A in ("%~dp0proxy.log") do if %%~zA GTR 5000000 del "%~dp0proxy.log"

netstat -ano | findstr /r /c:"LISTENING" | findstr ":8080" >nul 2>&1
if errorlevel 1 (
  start "ytm-proxy" /min cmd /c "node ""%~dp0server.mjs"" >> ""%~dp0proxy.log"" 2>&1"
  echo Started the media proxy on port 8080.
) else (
  echo Media proxy already running on port 8080.
)

rem ping rather than `timeout`: timeout refuses to run when stdin is redirected,
rem which is what happens if this is launched from a script.
ping -n 3 127.0.0.1 >nul

rem Only start a tunnel if one is not already forwarding: a second ssh to the
rem same remote port fails and closes its window immediately.
set HEALTH=http://15-204-247-1.sslip.io:8081/%YTM_SECRET%/health
set CODE=
for /f %%c in ('curl -s -m 4 -o NUL -w "%%{http_code}" %HEALTH%') do set CODE=%%c
if "%CODE%"=="200" (
  echo Tunnel already up.
) else (
  start "ytm-tunnel" /min ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 0.0.0.0:8081:127.0.0.1:8080 vps
  echo Started the tunnel to the VPS on port 8081.
)

echo.
echo Keep this machine awake while you listen. Close the two minimized
echo windows ("ytm-proxy", "ytm-tunnel") to stop.
ping -n 5 127.0.0.1 >nul
