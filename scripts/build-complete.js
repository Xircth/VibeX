const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 VibeUltra 完整构建脚本');

// 首先下载所有依赖
console.log('📥 下载构建依赖...');
execSync('node scripts/download-all-deps.js', {
  stdio: 'inherit'
});

// 设置环境变量
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
const nsisDir = path.join(__dirname, '..', 'src-tauri', 'target', 'deps', 'nsis');
process.env.WIXTOOLSDIR = wixDir;
process.env.NSIS_DIR = nsisDir;

console.log('\n🔨 开始构建...');
console.log('WIXTOOLSDIR:', wixDir);
console.log('NSIS_DIR:', nsisDir);

try {
  // 使用原生 cargo build 避免网络依赖
  console.log('1. 编译 Rust 代码...');
  execSync('cargo build --release', {
    stdio: 'inherit',
    env: { ...process.env }
  });

  console.log('\n2. 构建 Tauri 应用...');
  execSync('pnpm tauri build', {
    stdio: 'inherit',
    env: { ...process.env, WIXTOOLSDIR, NSIS_DIR }
  });

  console.log('\n🎉 构建完成！');
  console.log('输出位置: target/release/');
} catch (error) {
  console.error('❌ 构建失败:', error.message);
  process.exit(1);
}