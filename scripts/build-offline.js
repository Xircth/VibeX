const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('馃殌 VibeX 绂荤嚎鏋勫缓鑴氭湰');

// 璁剧疆 WIX 鐜鍙橀噺
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;

console.log('WIXTOOLSDIR:', wixDir);

// 妫€鏌?Wix 鏄惁瀛樺湪
if (!fs.existsSync(path.join(wixDir, 'candle.exe'))) {
  console.log('鉂?閿欒锛歐ix 鏈壘鍒般€傝鍏堣繍琛?node scripts/download-and-extract.js 涓嬭浇 Wix');
  process.exit(1);
}

console.log('鉁?Wix 宸插噯澶?);

// 灏濊瘯鐩存帴浣跨敤 cargo 鏋勫缓鑰屼笉鏄?tauri bundle
console.log('\n馃敤 寮€濮嬫瀯寤?..');

try {
  // 1. 缂栬瘧 Rust 浠ｇ爜
  console.log('1. 缂栬瘧 Rust 浠ｇ爜...');
  execSync('cargo build --release', {
    stdio: 'inherit'
  });

  console.log('\n2. 鏌ユ壘鏋勫缓浜х墿...');
  const exePath = path.join(__dirname, '..', 'target', 'release', 'vibex.exe');
  if (fs.existsSync(exePath)) {
    console.log('鉁?鍙墽琛屾枃浠跺凡鐢熸垚:', exePath);
    console.log('\n馃挕 鎻愮ず锛氬鏋滆鍒涘缓瀹夎鍖咃紝璇锋墜鍔ㄤ笅杞戒互涓嬪伐鍏凤細');
    console.log('   - NSIS: https://nsis.sourceforge.io/Download');
    console.log('   - WiX Toolset: https://wixtoolset.org/');
    console.log('\n鐒跺悗杩愯: pnpm tauri build');
  } else {
    console.log('鉂?鏈壘鍒板彲鎵ц鏂囦欢');
  }

  console.log('\n馃帀 鍩虹鏋勫缓瀹屾垚锛?);
} catch (error) {
  console.error('鉂?鏋勫缓澶辫触:', error.message);
  process.exit(1);
}