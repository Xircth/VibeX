@echo off
echo 正在设置本地 Wix 环境...

set WIX_DIR=%~dp0..\src-tauri\target\wix
set WIX_URL=https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip

:: 创建目录
if not exist "%WIX_DIR%" mkdir "%WIX_DIR%"

:: 检查是否已下载
if exist "%WIX_DIR%\candle.exe" (
    echo Wix 已存在，跳过下载
    goto :end
)

echo 下载 Wix...
curl -L -o "%WIX_DIR%\wix311-binaries.zip" "%WIX_URL%"
if errorlevel 1 (
    echo 下载失败，尝试使用 PowerShell...
    powershell -Command "& {Invoke-RestMethod -Uri '%WIX_URL%' -OutFile '%WIX_DIR%\wix311-binaries.zip'}"
    if errorlevel 1 (
        echo 所有下载方式都失败了
        exit /b 1
    )
)

echo 解压 Wix...
cd "%WIX_DIR%"
if exist "%WIX_DIR%\wix311-binaries.zip" (
    powershell -Command "Expand-Archive -Path 'wix311-binaries.zip' -DestinationPath '.' -Force"
    if errorlevel 1 (
        echo 解压失败
        exit /b 1
    )
    del wix311-binaries.zip
)

:end
echo Wix 准备完成！
echo 请确保设置环境变量: set WIXTOOLSDIR=%WIX_DIR%
pause