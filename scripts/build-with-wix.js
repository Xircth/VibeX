const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 开始构建 VibeUltra...');

// 检查 Wix 是否已下载
const wixDir = path.join(__dirname, 'src-tauri', 'target', 'wix');
const wixCandle = path.join(wixDir, 'candle.exe');

try {
  if (!require('fs').existsSync(wixCandle)) {
    console.log('📥 Wix 未找到，开始下载...');
    execSync('node download-wix.js', { cwd: __dirname });
  } else {
    console.log('✅ Wix 已存在');
  }

  console.log('🔨 开始构建...');
  execSync('pnpm tauri build', {
    cwd: __dirname,
    stdio: 'inherit'
  });

  console.log('🎉 构建完成！');
} catch (error) {
  console.error('❌ 构建失败:', error.message);
  process.exit(1);
}