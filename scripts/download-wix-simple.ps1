# PowerShell 脚本下载 Wix
$wixUrl = "https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip"
$wixDir = "src-tauri\target\wix"
$wixZip = Join-Path $wixDir "wix311-binaries.zip"

# 创建目录
if (!(Test-Path $wixDir)) {
    New-Item -ItemType Directory -Path $wixDir | Out-Null
}

Write-Host "下载 Wix..."
Invoke-WebRequest -Uri $wixUrl -OutFile $wixZip
Write-Host "下载完成，解压..."

# 解压
if (Test-Path $wixZip) {
    Expand-Archive -Path $wixZip -DestinationPath $wixDir -Force
    Remove-Item $wixZip
    Write-Host "Wix 已准备就绪！"
} else {
    Write-Host "下载失败"
    exit 1
}