const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('馃殌 VibeX Tauri 鏋勫缓鑴氭湰 - 鐗堟湰 2.0');

// 璁剧疆 WIX 鐜鍙橀噺
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;
process.env.RUST_BACKTRACE = '1';

console.log('WIXTOOLSDIR:', wixDir);

// 纭繚杈撳嚭鐩綍瀛樺湪
const releaseDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release');
if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

console.log('\n馃摝 妫€鏌ヤ緷璧?..');

// 妫€鏌?Cargo.toml 鐨勫唴瀹?
const cargoTomlPath = path.join(__dirname, '..', 'src-tauri', 'Cargo.toml');
if (!fs.existsSync(cargoTomlPath)) {
  console.error('鉂?鎵句笉鍒?Cargo.toml');
  process.exit(1);
}

// 妫€鏌ュ墠绔瀯寤虹洰褰?
const frontendDistDir = path.join(__dirname, '..', 'frontend', 'dist');
if (!fs.existsSync(frontendDistDir)) {
  console.log('馃彈锔? 鏋勫缓鍓嶇...');
  try {
    execSync('cd frontend && pnpm run build', {
      stdio: 'inherit',
      timeout: 60000
    });
  } catch (error) {
    console.error('鉂?鍓嶇鏋勫缓澶辫触:', error.message);
    process.exit(1);
  }
} else {
  console.log('鉁?鍓嶇鏋勫缓鏂囦欢宸插瓨鍦?);
}

console.log('\n馃敤 寮€濮?Rust 缂栬瘧...');

try {
  // 浣跨敤 cargo tauri build 鑰屼笉鏄洿鎺?cargo build
  console.log('杩愯: pnpm tauri build --no-bundle');

  execSync('pnpm tauri build --no-bundle', {
    stdio: 'inherit',
    env: {
      ...process.env,
      WIXTOOLSDIR: wixDir,
      RUST_BACKTRACE: '1'
    },
    timeout: 300000 // 5鍒嗛挓瓒呮椂
  });

  // 妫€鏌ョ敓鎴愮殑鏂囦欢
  const exePath = path.join(releaseDir, 'vibex.exe');
  console.log('\n馃帀 鏋勫缓瀹屾垚锛?);

  if (fs.existsSync(exePath)) {
    const stats = fs.statSync(exleasePath);
    console.log(`鉁?鍙墽琛屾枃浠? ${exePath}`);
    console.log(`馃搳 鏂囦欢澶у皬: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 妫€鏌ユ槸鍚︽湁瀹夎鍖?
    const msiPath = path.join(releaseDir, 'vibex_0.1.0_x64_en-US.msi');
    if (fs.existsSync(msiPath)) {
      const msiStats = fs.statSync(msiPath);
      console.log(`鉁?MSI 瀹夎鍖? ${msiPath}`);
      console.log(`馃搳 MSI 澶у皬: ${(msiStats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.log('鈿狅笍  鏈壘鍒?MSI 瀹夎鍖咃紙浣跨敤 --no-bundle 鏄甯哥殑锛?);
    }

    // 鍒楀嚭 release 鐩綍鐨勬墍鏈夋枃浠?
    console.log('\n馃搧 Release 鐩綍鍐呭:');
    fs.readdirSync(releaseDir).forEach(file => {
      const filePath = path.join(releaseDir, file);
      const stats = fs.statSync(filePath);
      console.log(`  - ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    });

  } else {
    console.error('鉂?鏈壘鍒板彲鎵ц鏂囦欢');
    process.exit(1);
  }

} catch (error) {
  console.error('鉂?鏋勫缓澶辫触:');
  console.error(error.message);

  if (error.stdout) {
    console.error('\n--- stdout ---\n' + error.stdout.toString());
  }
  if (error.stderr) {
    console.error('\n--- stderr ---\n' + error.stderr.toString());
  }

  // 灏濊瘯浣跨敤 cargo build 浣滀负鍚庡鏂规
  console.log('\n馃攧 灏濊瘯浣跨敤 cargo build 浣滀负鍚庡...');
  try {
    execSync('cd src-tauri && cargo build --release', {
      stdio: 'inherit',
      timeout: 300000
    });
    console.log('鉁?cargo build 鎴愬姛锛?);
    console.log('娉ㄦ剰: 杩欏彧鐢熸垚浜?exe锛屾病鏈夊畨瑁呭寘');
  } catch (fallbackError) {
    console.error('鉂?鍚庡鏂规涔熷け璐ヤ簡:', fallbackError.message);
    process.exit(1);
  }

  process.exit(1);
}