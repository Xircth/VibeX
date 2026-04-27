@echo off
echo ========================
echo VibeX 鏋勫缓鑴氭湰
echo ========================

:: 璁剧疆宸ヤ綔鐩綍
cd /d "%~dp0"

:: 妫€鏌ュ苟涓嬭浇 Wix
echo [1/3] 妫€鏌?Wix...
set WIX_DIR=..\src-tauri\target\wix
if not exist "%WIX_DIR%" mkdir "%WIX_DIR%"

if not exist "%WIX_DIR%\candle.exe" (
    echo 姝ｅ湪涓嬭浇 Wix...
    curl -L -o "%WIX_DIR%\wix311-binaries.zip" "https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip"
    if %ERRORLEVEL% neq 0 (
        echo Curl 涓嬭浇澶辫触锛屽皾璇?PowerShell...
        powershell -Command "& {Invoke-RestMethod -Uri 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip' -OutFile '..\src-tauri\target\wix\wix311-binaries.zip'}"
        if %ERRORLEVEL% neq 0 (
            echo 鉂?鎵€鏈変笅杞芥柟寮忛兘澶辫触浜?
            pause
            exit /b 1
        )
    )

    echo 姝ｅ湪瑙ｅ帇...
    cd "%WIX_DIR%"
    powershell -Command "Expand-Archive -Path 'wix311-binaries.zip' -DestinationPath '.' -Force"
    if %ERRORLEVEL% neq 0 (
        echo 鉂?瑙ｅ帇澶辫触
        pause
        exit /b 1
    )
    del wix311-binaries.zip
    cd ..
) else (
    echo 鉁?Wix 宸插瓨鍦?
)

:: 璁剧疆 WIX 鐜鍙橀噺
echo [2/3] 璁剧疆鐜鍙橀噺...
set WIXTOOLSDIR=%~dp0..\src-tauri\target\wix

:: 鏋勫缓
echo [3/3] 寮€濮嬫瀯寤?..
call pnpm tauri build

if %ERRORLEVEL% neq 0 (
    echo 鉂?鏋勫缓澶辫触
    pause
    exit /b 1
)

echo 馃帀 鏋勫缓瀹屾垚锛?
pause