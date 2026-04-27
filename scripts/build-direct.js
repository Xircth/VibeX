const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('馃殌 VibeX 鐩存帴鏋勫缓鑴氭湰');

// 璁剧疆鐜鍙橀噺
const wixDir = path.join(__dirname, '..', 'src-tauri', 'target', 'wix');
process.env.WIXTOOLSDIR = wixDir;
process.env.CARGO_TERM_COLOR = 'always';

console.log('WIXTOOLSDIR:', wixDir);

// 纭繚璺緞鏄粷瀵硅矾寰?
process.chdir(__dirname);

// 妫€鏌ュ墠绔槸鍚﹀凡缁忔瀯寤?
const frontendDistDir = path.join(__dirname, '..', 'frontend', 'dist');
if (!fs.existsSync(frontendDistDir)) {
  console.log('馃摝 鏋勫缓鍓嶇...');
  execSync('cd frontend && pnpm run build', { stdio: 'inherit' });
}

console.log('\n馃敤 寮€濮嬫瀯寤?..');

try {
  // 鐩存帴浣跨敤 @tauri-apps/cli
  console.log('杩愯: npx @tauri-apps/cli build --no-bundle');

  execSync('npx @tauri-apps/cli build --no-bundle', {
    stdio: 'inherit',
    env: {
      ...process.env,
      WIXTOOLSDIR: wixDir,
      CARGO_TERM_COLOR: 'always'
    },
    cwd: path.join(__dirname, '..'),
    timeout: 600000 // 10鍒嗛挓
  });

  // 妫€鏌ヨ緭鍑?
  const exePath = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'vibex.exe');
  if (fs.existsSync(exePath)) {
    const stats = fs.statSync(exePath);
    console.log('\n鉁?鏋勫缓鎴愬姛锛?);
    console.log(`馃搧 EXE 鏂囦欢: ${exePath}`);
    console.log(`馃搳 鏂囦欢澶у皬: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 鍒楀嚭杈撳嚭鐩綍鐨勬墍鏈夋枃浠?
    const outputDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release');
    console.log('\n馃摝 杈撳嚭鐩綍鍐呭:');
    fs.readdirSync(outputDir).forEach(file => {
      const filePath = path.join(outputDir, file);
      const stats = fs.statSync(filePath);
      const isDir = stats.isDirectory();
      console.log(`  - ${file} ${isDir ? '(鐩綍)' : `(${(stats.size / 1024 / 1024).toFixed(2)} MB)`}`);
    });

  } else {
    console.error('\n鉂?鏈壘鍒?EXE 鏂囦欢');

    // 灏濊瘯浣跨敤 cargo build
    console.log('\n馃攧 灏濊瘯浣跨敤 cargo build...');
    execSync('cd src-tauri && cargo build --release', {
      stdio: 'inherit',
      timeout: 300000
    });

    const fallbackExePath = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'vibex.exe');
    if (fs.existsSync(fallbackExePath)) {
      const stats = fs.statSync(fallbackExePath);
      console.log('鉁?cargo build 鎴愬姛锛?);
      console.log(`馃搧 EXE 鏂囦欢: ${fallbackExePath}`);
      console.log(`馃搳 鏂囦欢澶у皬: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
      console.error('鉂?鎵€鏈夋瀯寤烘柟娉曢兘澶辫触浜?);
      process.exit(1);
    }
  }

} catch (error) {
  console.error('鉂?鏋勫缓澶辫触:', error.message);

  // 濡傛灉鏄?WIX 鐩稿叧閿欒锛屾彁渚涙洿璇︾粏鐨勯敊璇俊鎭?
  if (error.message.includes('WIX') || error.message.includes('wix')) {
    console.log('\n馃敡 WIX 鐩稿叧閿欒鍙兘鐨勫師鍥?');
    console.log('1. WIXTOOLSDIR 璺緞閿欒');
    console.log('2. WIX 宸ュ叿鏈纭畨瑁?);
    console.log('3. 鏉冮檺闂');

    // 鏄剧ず瀹為檯鐨?WIX 璺緞
    console.log(`\nWIXTOOLSDIR 妫€鏌? ${wixDir}`);
    if (fs.existsSync(wixDir)) {
      console.log('鉁?WIX 鐩綍瀛樺湪');
      if (fs.existsSync(path.join(wixDir, 'candle.exe'))) {
        console.log('鉁?candle.exe 瀛樺湪');
      } else {
        console.log('鉂?candle.exe 涓嶅瓨鍦?);
      }
    } else {
      console.log('鉂?WIX 鐩綍涓嶅瓨鍦?);
    }
  }

  process.exit(1);
}