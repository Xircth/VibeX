const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
const wixZip = path.join(wixDir, 'wix311-binaries.zip');

console.log('🚀 开始准备 Wix...');

// 确保目录存在
if (!fs.existsSync(wixDir)) {
  fs.mkdirSync(wixDir, { recursive: true });
}

// 检查是否已下载
if (fs.existsSync(path.join(wixDir, 'candle.exe'))) {
  console.log('✅ Wix 已存在');
  process.exit(0);
}

console.log('📥 下载 Wix...');
try {
  // 使用 curl 下载
  execSync(`curl -L -o "${wixZip}" "https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip"`, {
    stdio: 'inherit',
    timeout: 300000
  });

  console.log('📦 解压 Wix...');
  // 使用 PowerShell 解压
  execSync(`powershell -Command "Expand-Archive -Path '${wixZip}' -DestinationPath '${wixDir}' -Force"`, {
    stdio: 'inherit'
  });

  // 删除 zip 文件
  fs.unlinkSync(wixZip);

  console.log('🎉 Wix 准备完成！');
  console.log(`WIXTOOLSDIR 路径: ${wixDir}`);

  // 设置环境变量（在当前会话中）
  process.env.WIXTOOLSDIR = wixDir;
  console.log('已设置 WIXTOOLSDIR 环境变量');

} catch (error) {
  console.error('❌ 准备失败:', error.message);
  process.exit(1);
}