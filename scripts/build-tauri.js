const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 VibeUltra 构建脚本');

// 设置 WIX 环境变量
process.env.WIXTOOLSDIR = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');

console.log('WIXTOOLSDIR:', process.env.WIXTOOLSDIR);

console.log('🔨 开始构建...');
try {
  execSync('pnpm tauri build', {
    stdio: 'inherit',
    env: { ...process.env, WIXTOOLSDIR: process.env.WIXTOOLSDIR }
  });
  console.log('🎉 构建完成！');
} catch (error) {
  console.error('❌ 构建失败:', error.message);
  process.exit(1);
}