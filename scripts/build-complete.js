const { execSync } = require('child_process');
const path = require('path');

console.log('馃殌 VibeX 瀹屾暣鏋勫缓鑴氭湰');

// 棣栧厛涓嬭浇鎵€鏈変緷璧?
console.log('馃摜 涓嬭浇鏋勫缓渚濊禆...');
execSync('node scripts/download-all-deps.js', {
  stdio: 'inherit'
});

// 璁剧疆鐜鍙橀噺
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
const nsisDir = path.join(__dirname, '..', 'src-tauri', 'target', 'deps', 'nsis');
process.env.WIXTOOLSDIR = wixDir;
process.env.NSIS_DIR = nsisDir;

console.log('\n馃敤 寮€濮嬫瀯寤?..');
console.log('WIXTOOLSDIR:', wixDir);
console.log('NSIS_DIR:', nsisDir);

try {
  // 浣跨敤鍘熺敓 cargo build 閬垮厤缃戠粶渚濊禆
  console.log('1. 缂栬瘧 Rust 浠ｇ爜...');
  execSync('cargo build --release', {
    stdio: 'inherit',
    env: { ...process.env }
  });

  console.log('\n2. 鏋勫缓 Tauri 搴旂敤...');
  execSync('pnpm tauri build', {
    stdio: 'inherit',
    env: { ...process.env, WIXTOOLSDIR, NSIS_DIR }
  });

  console.log('\n馃帀 鏋勫缓瀹屾垚锛?);
  console.log('杈撳嚭浣嶇疆: target/release/');
} catch (error) {
  console.error('鉂?鏋勫缓澶辫触:', error.message);
  process.exit(1);
}