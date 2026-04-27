const { execSync } = require('child_process');
const path = require('path');

console.log('馃殌 VibeX 浠呯敓鎴愬彲鎵ц鏂囦欢鑴氭湰');

// 璁剧疆 WIX 鐜鍙橀噺锛堝嵆浣夸笉浣跨敤 bundle锛屾煇浜涗緷璧栧彲鑳介渶瑕侊級
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;

console.log('WIXTOOLSDIR:', wixDir);

console.log('\n馃敤 寮€濮嬫瀯寤猴紙涓嶅垱寤哄畨瑁呭寘锛?..');

try {
  // 浣跨敤 --no-bundle 鏍囧織璺宠繃瀹夎鍖呭垱寤?
  execSync('pnpm tauri build --no-bundle', {
    stdio: 'inherit'
  });

  console.log('\n馃帀 鏋勫缓瀹屾垚锛?);
  console.log('鍙墽琛屾枃浠朵綅缃? target/release/vibex.exe');

  // 妫€鏌ユ枃浠舵槸鍚﹀瓨鍦?
  const exePath = path.join(__dirname, '..', 'target', 'release', 'vibex.exe');
  const stats = require('fs').statSync(exePath);
  console.log(`鏂囦欢澶у皬: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

} catch (error) {
  // 濡傛灉 --no-bundle 涓嶆敮鎸侊紝灏濊瘯鐩存帴缂栬瘧
  console.log('\n鈿狅笍  --no-bundle 涓嶆敮鎸侊紝灏濊瘯鐩存帴缂栬瘧...');

  try {
    // 1. 鏋勫缓鍓嶇
    console.log('1. 鏋勫缓鍓嶇...');
    execSync('pnpm --filter ./frontend build', {
      stdio: 'inherit'
    });

    // 2. 鐩存帴浣跨敤 cargo build
    console.log('\n2. 缂栬瘧 Rust 浠ｇ爜...');
    execSync('cargo build --release', {
      stdio: 'inherit'
    });

    const exePath = path.join(__dirname, '..', 'target', 'release', 'vibex.exe');
    if (require('fs').existsSync(exePath)) {
      console.log('\n鉁?鍙墽琛屾枃浠跺凡鐢熸垚:', exePath);
    }

  } catch (buildError) {
    console.error('鉂?鏋勫缓澶辫触:', buildError.message);
    process.exit(1);
  }
}