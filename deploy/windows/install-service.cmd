@echo off
setlocal
if "%~1"=="" (
  echo Usage: install-service.cmd path\to\dimo-server.exe
  exit /b 2
)
set "DATA=%PROGRAMDATA%\Dimo"
set "WEB=%~dp1web"
mkdir "%DATA%" 2>nul
nssm install DimoServer "%~1"
nssm set DimoServer AppDirectory "%~dp1"
nssm set DimoServer AppEnvironmentExtra DIMO_DATA_DIR="%DATA%" DIMO_STATIC_ROOT="%WEB%" DIMO_SERVER_LISTEN=127.0.0.1:17891
nssm set DimoServer Start SERVICE_AUTO_START
nssm start DimoServer
endlocal
