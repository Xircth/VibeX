const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 VibeUltra Tauri 构建脚本 - 版本 2.0');

// 设置 WIX 环境变量
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;
process.env.RUST_BACKTRACE = '1';

console.log('WIXTOOLSDIR:', wixDir);

// 确保输出目录存在
const releaseDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release');
if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

console.log('\n📦 检查依赖...');

// 检查 Cargo.toml 的内容
const cargoTomlPath = path.join(__dirname, '..', 'src-tauri', 'Cargo.toml');
if (!fs.existsSync(cargoTomlPath)) {
  console.error('❌ 找不到 Cargo.toml');
  process.exit(1);
}

// 检查前端构建目录
const frontendDistDir = path.join(__dirname, '..', 'frontend', 'dist');
if (!fs.existsSync(frontendDistDir)) {
  console.log('🏗️  构建前端...');
  try {
    execSync('cd frontend && pnpm run build', {
      stdio: 'inherit',
      timeout: 60000
    });
  } catch (error) {
    console.error('❌ 前端构建失败:', error.message);
    process.exit(1);
  }
} else {
  console.log('✅ 前端构建文件已存在');
}

console.log('\n🔨 开始 Rust 编译...');

try {
  // 使用 cargo tauri build 而不是直接 cargo build
  console.log('运行: pnpm tauri build --no-bundle');

  execSync('pnpm tauri build --no-bundle', {
    stdio: 'inherit',
    env: {
      ...process.env,
      WIXTOOLSDIR: wixDir,
      RUST_BACKTRACE: '1'
    },
    timeout: 300000 // 5分钟超时
  });

  // 检查生成的文件
  const exePath = path.join(releaseDir, 'vibe-ultra.exe');
  console.log('\n🎉 构建完成！');

  if (fs.existsSync(exePath)) {
    const stats = fs.statSync(exleasePath);
    console.log(`✅ 可执行文件: ${exePath}`);
    console.log(`📊 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 检查是否有安装包
    const msiPath = path.join(releaseDir, 'vibe-ultra_0.1.0_x64_en-US.msi');
    if (fs.existsSync(msiPath)) {
      const msiStats = fs.statSync(msiPath);
      console.log(`✅ MSI 安装包: ${msiPath}`);
      console.log(`📊 MSI 大小: ${(msiStats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.log('⚠️  未找到 MSI 安装包（使用 --no-bundle 是正常的）');
    }

    // 列出 release 目录的所有文件
    console.log('\n📁 Release 目录内容:');
    fs.readdirSync(releaseDir).forEach(file => {
      const filePath = path.join(releaseDir, file);
      const stats = fs.statSync(filePath);
      console.log(`  - ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    });

  } else {
    console.error('❌ 未找到可执行文件');
    process.exit(1);
  }

} catch (error) {
  console.error('❌ 构建失败:');
  console.error(error.message);

  if (error.stdout) {
    console.error('\n--- stdout ---\n' + error.stdout.toString());
  }
  if (error.stderr) {
    console.error('\n--- stderr ---\n' + error.stderr.toString());
  }

  // 尝试使用 cargo build 作为后备方案
  console.log('\n🔄 尝试使用 cargo build 作为后备...');
  try {
    execSync('cd src-tauri && cargo build --release', {
      stdio: 'inherit',
      timeout: 300000
    });
    console.log('✅ cargo build 成功！');
    console.log('注意: 这只生成了 exe，没有安装包');
  } catch (fallbackError) {
    console.error('❌ 后备方案也失败了:', fallbackError.message);
    process.exit(1);
  }

  process.exit(1);
}