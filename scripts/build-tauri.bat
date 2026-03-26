@echo off
echo 设置 WIX 环境变量...
set WIXTOOLSDIR=src-tauri\target\wix

echo 开始构建...
call pnpm tauri build

if %ERRORLEVEL% neq 0 (
    echo 构建失败
    pause
    exit /b 1
)

echo 构建完成！
pause