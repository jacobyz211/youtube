@echo off
rem Click this to start playback support on this laptop: the media proxy plus the
rem SSH reverse tunnel that gives it a permanent address on the VPS.
rem Nothing here starts automatically at login — that is deliberate.
setlocal

set YTM_SECRET=k7f2q9w4e1r8t5y3u6i0o2p4a6s8d0g2
set YTM_WARP_LOCAL_ADDR=
set YTM_YTDLP=
set PORT=8080

netstat -ano | findstr /r /c:"LISTENING" | findstr ":8080" >nul 2>&1
if errorlevel 1 (
  start "ytm-proxy" /min cmd /c "node ""%~dp0server.mjs"""
  echo Started the media proxy on port 8080.
) else (
  echo Media proxy already running on port 8080.
)

rem ping rather than `timeout`: timeout refuses to run when stdin is redirected,
rem which is what happens if this is launched from a script.
ping -n 3 127.0.0.1 >nul

start "ytm-tunnel" /min ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R 0.0.0.0:8081:127.0.0.1:8080 vps

echo.
echo Tunnel started: the VPS forwards port 8081 back to this laptop.
echo Keep this machine awake while you listen. Close the two minimized
echo windows ("ytm-proxy", "ytm-tunnel") to stop.
ping -n 5 127.0.0.1 >nul
