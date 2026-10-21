@echo off
setlocal
set "PATH=%~dp0.runtime\node-v24.22.0-win-x64;%PATH%"
cd /d "%~dp0"
node scripts\online.mjs
if errorlevel 1 pause
