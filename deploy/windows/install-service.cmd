@echo off
setlocal
if "%~1"=="" (
  echo Usage: install-service.cmd path\to\vibex-server.exe
  exit /b 2
)
set "DATA=%PROGRAMDATA%\VibeX"
set "WEB=%~dp1web"
mkdir "%DATA%" 2>nul
nssm install VibeXServer "%~1"
nssm set VibeXServer AppDirectory "%~dp1"
nssm set VibeXServer AppEnvironmentExtra VIBEX_DATA_DIR="%DATA%" VIBEX_STATIC_ROOT="%WEB%" VIBEX_SERVER_LISTEN=127.0.0.1:17891
nssm set VibeXServer Start SERVICE_AUTO_START
nssm start VibeXServer
endlocal
