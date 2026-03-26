const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 开始下载 Wix...');

// Wix 下载 URL（使用微软官方下载地址）
const wixUrl = 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip';
// 使用 GitHub releases 的原始文件链接，避免重定向
const wixDownloadUrl = 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip';
// 或者使用微软镜像（如果 GitHub 太慢）
const microsoftMirror = 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip';
const wixDir = path.join(__dirname, 'src-tauri', 'target', 'wix');
const wixZipPath = path.join(wixDir, 'wix311-binaries.zip');

// 确保目录存在
if (!fs.existsSync(wixDir)) {
  fs.mkdirSync(wixDir, { recursive: true });
}

// 下载文件（处理重定向）
function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);

    const request = https.get(url, (response) => {
      console.log(`重定向到: ${response.responseUrl}`);
      console.log(`状态码: ${response.statusCode}`);

      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // 处理重定向
        console.log(`跟随重定向到: ${response.headers.location}`);
        downloadFile(response.headers.location, filePath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`下载失败，状态码: ${response.statusCode}`));
        return;
      }

      const total = parseInt(response.headers['content-length']) || 0;
      let downloaded = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const percent = (downloaded / total * 100).toFixed(2);
          process.stdout.write(`下载进度: ${percent}%\r`);
        } else {
          process.stdout.write(`已下载: ${(downloaded / 1024 / 1024).toFixed(2)} MB\r`);
        }
      });

      file.on('finish', () => {
        file.close();
        console.log('\n✅ 下载完成');
        resolve();
      });

      response.pipe(file);
    });

    request.on('error', reject);
  });
}

// 解压文件
function extractZip() {
  console.log('📦 解压 Wix...');

  // 使用系统自带的 tar 或 PowerShell 解压
  if (process.platform === 'win32') {
    // Windows 使用 PowerShell
    execSync(`powershell -Command "Expand-Archive -Path '${wixZipPath}' -DestinationPath '${wixDir}' -Force"`);
  } else {
    // Linux/Mac 使用 tar
    execSync(`cd ${wixDir} && unzip -o ${path.basename(wixZipPath)}`);
  }

  // 删除 zip 文件
  fs.unlinkSync(wixZipPath);
  console.log('✅ 解压完成');
}

// 检查是否已存在
if (fs.existsSync(path.join(wixDir, 'candle.exe'))) {
  console.log('✅ Wix 已存在，跳过下载');
  process.exit(0);
}

// 开始下载
downloadFile(wixUrl, wixZipPath)
  .then(() => {
    extractZip();
    console.log('🎉 Wix 准备完成！');
  })
  .catch(error => {
    console.error('❌ 下载失败:', error.message);
    process.exit(1);
  });