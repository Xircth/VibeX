const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 VibeUltra 直接构建脚本');

// 设置环境变量
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;
process.env.CARGO_TERM_COLOR = 'always';

console.log('WIXTOOLSDIR:', wixDir);

// 确保路径是绝对路径
process.chdir(__dirname);

// 检查前端是否已经构建
const frontendDistDir = path.join(__dirname, '..', 'frontend', 'dist');
if (!fs.existsSync(frontendDistDir)) {
  console.log('📦 构建前端...');
  execSync('cd frontend && pnpm run build', { stdio: 'inherit' });
}

console.log('\n🔨 开始构建...');

try {
  // 直接使用 @tauri-apps/cli
  console.log('运行: npx @tauri-apps/cli build --no-bundle');

  execSync('npx @tauri-apps/cli build --no-bundle', {
    stdio: 'inherit',
    env: {
      ...process.env,
      WIXTOOLSDIR: wixDir,
      CARGO_TERM_COLOR: 'always'
    },
    cwd: path.join(__dirname, '..'),
    timeout: 600000 // 10分钟
  });

  // 检查输出
  const exePath = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'vibe-ultra.exe');
  if (fs.existsSync(exePath)) {
    const stats = fs.statSync(exePath);
    console.log('\n✅ 构建成功！');
    console.log(`📁 EXE 文件: ${exePath}`);
    console.log(`📊 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 列出输出目录的所有文件
    const outputDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release');
    console.log('\n📦 输出目录内容:');
    fs.readdirSync(outputDir).forEach(file => {
      const filePath = path.join(outputDir, file);
      const stats = fs.statSync(filePath);
      const isDir = stats.isDirectory();
      console.log(`  - ${file} ${isDir ? '(目录)' : `(${(stats.size / 1024 / 1024).toFixed(2)} MB)`}`);
    });

  } else {
    console.error('\n❌ 未找到 EXE 文件');

    // 尝试使用 cargo build
    console.log('\n🔄 尝试使用 cargo build...');
    execSync('cd src-tauri && cargo build --release', {
      stdio: 'inherit',
      timeout: 300000
    });

    const fallbackExePath = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'vibe-ultra.exe');
    if (fs.existsSync(fallbackExePath)) {
      const stats = fs.statSync(fallbackExePath);
      console.log('✅ cargo build 成功！');
      console.log(`📁 EXE 文件: ${fallbackExePath}`);
      console.log(`📊 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.error('❌ 所有构建方法都失败了');
      process.exit(1);
    }
  }

} catch (error) {
  console.error('❌ 构建失败:', error.message);

  // 如果是 WIX 相关错误，提供更详细的错误信息
  if (error.message.includes('WIX') || error.message.includes('wix')) {
    console.log('\n🔧 WIX 相关错误可能的原因:');
    console.log('1. WIXTOOLSDIR 路径错误');
    console.log('2. WIX 工具未正确安装');
    console.log('3. 权限问题');

    // 显示实际的 WIX 路径
    console.log(`\nWIXTOOLSDIR 检查: ${wixDir}`);
    if (fs.existsSync(wixDir)) {
      console.log('✅ WIX 目录存在');
      if (fs.existsSync(path.join(wixDir, 'candle.exe'))) {
        console.log('✅ candle.exe 存在');
      } else {
        console.log('❌ candle.exe 不存在');
      }
    } else {
      console.log('❌ WIX 目录不存在');
    }
  }

  process.exit(1);
}