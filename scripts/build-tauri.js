const { execSync } = require('child_process');
const path = require('path');

console.log('馃殌 VibeX 鏋勫缓鑴氭湰');

// 璁剧疆 WIX 鐜鍙橀噺
process.env.WIXTOOLSDIR = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');

console.log('WIXTOOLSDIR:', process.env.WIXTOOLSDIR);

console.log('馃敤 寮€濮嬫瀯寤?..');
try {
  execSync('pnpm tauri build', {
    stdio: 'inherit',
    env: { ...process.env, WIXTOOLSDIR: process.env.WIXTOOLSDIR }
  });
  console.log('馃帀 鏋勫缓瀹屾垚锛?);
} catch (error) {
  console.error('鉂?鏋勫缓澶辫触:', error.message);
  process.exit(1);
}