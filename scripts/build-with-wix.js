const { execSync } = require('child_process');
const path = require('path');

console.log('馃殌 寮€濮嬫瀯寤?VibeX...');

// 妫€鏌?Wix 鏄惁宸蹭笅杞?
const wixDir = path.join(__dirname, 'src-tauri', 'target', 'wix');
const wixCandle = path.join(wixDir, 'candle.exe');

try {
  if (!require('fs').existsSync(wixCandle)) {
    console.log('馃摜 Wix 鏈壘鍒帮紝寮€濮嬩笅杞?..');
    execSync('node download-wix.js', { cwd: __dirname });
  } else {
    console.log('鉁?Wix 宸插瓨鍦?);
  }

  console.log('馃敤 寮€濮嬫瀯寤?..');
  execSync('pnpm tauri build', {
    cwd: __dirname,
    stdio: 'inherit'
  });

  console.log('馃帀 鏋勫缓瀹屾垚锛?);
} catch (error) {
  console.error('鉂?鏋勫缓澶辫触:', error.message);
  process.exit(1);
}