@echo off
rem Uso: start-prod.cmd https://sua-url-publica
rem Sem argumento, usa http://127.0.0.1:4000 (acesso local).
setlocal
if "%~1"=="" (
  set "PUBLIC_BASE_URL=http://127.0.0.1:4000"
) else (
  set "PUBLIC_BASE_URL=%~1"
)
set "NODE_ENV=production"
set "PORT=4000"
set "PATH=%~dp0..\.runtime\node-v24.22.0-win-x64;%PATH%"
cd /d "%~dp0"
echo [prod] PUBLIC_BASE_URL=%PUBLIC_BASE_URL%
node dist\index.js
