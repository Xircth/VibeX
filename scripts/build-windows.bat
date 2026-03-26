@echo off
echo ========================
echo VibeUltra 构建脚本
echo ========================

:: 设置工作目录
cd /d "%~dp0"

:: 检查并下载 Wix
echo [1/3] 检查 Wix...
set WIX_DIR=..\src-tauri\target\wix
if not exist "%WIX_DIR%" mkdir "%WIX_DIR%"

if not exist "%WIX_DIR%\candle.exe" (
    echo 正在下载 Wix...
    curl -L -o "%WIX_DIR%\wix311-binaries.zip" "https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip"
    if %ERRORLEVEL% neq 0 (
        echo Curl 下载失败，尝试 PowerShell...
        powershell -Command "& {Invoke-RestMethod -Uri 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip' -OutFile '..\src-tauri\target\wix\wix311-binaries.zip'}"
        if %ERRORLEVEL% neq 0 (
            echo ❌ 所有下载方式都失败了
            pause
            exit /b 1
        )
    )

    echo 正在解压...
    cd "%WIX_DIR%"
    powershell -Command "Expand-Archive -Path 'wix311-binaries.zip' -DestinationPath '.' -Force"
    if %ERRORLEVEL% neq 0 (
        echo ❌ 解压失败
        pause
        exit /b 1
    )
    del wix311-binaries.zip
    cd ..
) else (
    echo ✅ Wix 已存在
)

:: 设置 WIX 环境变量
echo [2/3] 设置环境变量...
set WIXTOOLSDIR=%~dp0..\src-tauri\target\wix

:: 构建
echo [3/3] 开始构建...
call pnpm tauri build

if %ERRORLEVEL% neq 0 (
    echo ❌ 构建失败
    pause
    exit /b 1
)

echo 🎉 构建完成！
pause