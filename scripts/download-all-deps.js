const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 下载所有构建依赖...');

const depsDir = path.join(__dirname, '..', 'src-tauri', 'target', 'deps');
if (!fs.existsSync(depsDir)) {
  fs.mkdirSync(depsDir, { recursive: true });
}

// 下载 Wix
console.log('1️⃣ 检查 Wix...');
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
if (!fs.existsSync(path.join(wixDir, 'candle.exe'))) {
  console.log('下载 Wix...');
  execSync(`curl -L -o "${path.join(wixDir, 'wix311-binaries.zip')}" "https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip"`, {
    stdio: 'inherit',
    timeout: 300000
  });
  execSync(`powershell -Command "Expand-Archive -Path '${path.join(wixDir, 'wix311-binaries.zip')}' -DestinationPath '${wixDir}' -Force"`, {
    stdio: 'inherit'
  });
  fs.unlinkSync(path.join(wixDir, 'wix311-binaries.zip'));
  console.log('✅ Wix 已准备');
}

// 下载 NSIS
console.log('2️⃣ 检查 NSIS...');
const nsisDir = path.join(depsDir, 'nsis');
if (!fs.existsSync(path.join(nsisDir, 'makensis.exe'))) {
  console.log('下载 NSIS...');
  if (!fs.existsSync(nsisDir)) {
    fs.mkdirSync(nsisDir, { recursive: true });
  }

  // 使用 nsis.org 的官方下载链接
  const nsisUrl = 'https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download';
  execSync(`curl -L -o "${path.join(nsisDir, 'nsis-3.11.zip')}" "${nsisUrl}"`, {
    stdio: 'inherit',
    timeout: 300000
  });

  console.log('解压 NSIS...');
  execSync(`powershell -Command "Expand-Archive -Path '${path.join(nsisDir, 'nsis-3.11.zip')}' -DestinationPath '${nsisDir}' -Force"`, {
    stdio: 'inherit'
  });

  // 移动文件到根目录
  const extractedDir = path.join(nsisDir, 'nsis-3.11');
  if (fs.existsSync(extractedDir)) {
    const files = fs.readdirSync(extractedDir);
    files.forEach(file => {
      fs.renameSync(
        path.join(extractedDir, file),
        path.join(nsisDir, file)
      );
    });
    fs.rmSync(extractedDir, { recursive: true });
  }

  fs.unlinkSync(path.join(nsisDir, 'nsis-3.11.zip'));
  console.log('✅ NSIS 已准备');
}

// 设置环境变量
process.env.WIXTOOLSDIR = wixDir;
process.env.NSIS_DIR = nsisDir;

console.log('\n🎉 所有依赖准备完成！');
console.log(`WIXTOOLSDIR: ${wixDir}`);
console.log(`NSIS_DIR: ${nsisDir}`);