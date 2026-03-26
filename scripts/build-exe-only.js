const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 VibeUltra 仅生成可执行文件脚本');

// 设置 WIX 环境变量（即使不使用 bundle，某些依赖可能需要）
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;

console.log('WIXTOOLSDIR:', wixDir);

console.log('\n🔨 开始构建（不创建安装包）...');

try {
  // 使用 --no-bundle 标志跳过安装包创建
  execSync('pnpm tauri build --no-bundle', {
    stdio: 'inherit'
  });

  console.log('\n🎉 构建完成！');
  console.log('可执行文件位置: target/release/vibe-ultra.exe');

  // 检查文件是否存在
  const exePath = path.join(__dirname, '..', 'target', 'release', 'vibe-ultra.exe');
  const stats = require('fs').statSync(exePath);
  console.log(`文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

} catch (error) {
  // 如果 --no-bundle 不支持，尝试直接编译
  console.log('\n⚠️  --no-bundle 不支持，尝试直接编译...');

  try {
    // 1. 构建前端
    console.log('1. 构建前端...');
    execSync('pnpm --filter ./frontend build', {
      stdio: 'inherit'
    });

    // 2. 直接使用 cargo build
    console.log('\n2. 编译 Rust 代码...');
    execSync('cargo build --release', {
      stdio: 'inherit'
    });

    const exePath = path.join(__dirname, '..', 'target', 'release', 'vibe-ultra.exe');
    if (require('fs').existsSync(exePath)) {
      console.log('\n✅ 可执行文件已生成:', exePath);
    }

  } catch (buildError) {
    console.error('❌ 构建失败:', buildError.message);
    process.exit(1);
  }
}