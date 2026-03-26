const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 VibeUltra 离线构建脚本');

// 设置 WIX 环境变量
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;

console.log('WIXTOOLSDIR:', wixDir);

// 检查 Wix 是否存在
if (!fs.existsSync(path.join(wixDir, 'candle.exe'))) {
  console.log('❌ 错误：Wix 未找到。请先运行 node scripts/download-and-extract.js 下载 Wix');
  process.exit(1);
}

console.log('✅ Wix 已准备');

// 尝试直接使用 cargo 构建而不是 tauri bundle
console.log('\n🔨 开始构建...');

try {
  // 1. 编译 Rust 代码
  console.log('1. 编译 Rust 代码...');
  execSync('cargo build --release', {
    stdio: 'inherit'
  });

  console.log('\n2. 查找构建产物...');
  const exePath = path.join(__dirname, '..', 'target', 'release', 'vibe-ultra.exe');
  if (fs.existsSync(exePath)) {
    console.log('✅ 可执行文件已生成:', exePath);
    console.log('\n💡 提示：如果要创建安装包，请手动下载以下工具：');
    console.log('   - NSIS: https://nsis.sourceforge.io/Download');
    console.log('   - WiX Toolset: https://wixtoolset.org/');
    console.log('\n然后运行: pnpm tauri build');
  } else {
    console.log('❌ 未找到可执行文件');
  }

  console.log('\n🎉 基础构建完成！');
} catch (error) {
  console.error('❌ 构建失败:', error.message);
  process.exit(1);
}