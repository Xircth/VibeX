import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('blurred main window uses detached desktop toast instead of inline toast fallback', () => {
  const source = readFrontendFile(
    'src/components/layout/ProjectWindowManager.tsx'
  );
  const blurredWindowBranch = source.match(
    /if \(!windowFocused\) \{([\s\S]*?)\n          }\n\n          showInlineToast/
  );

  assert.match(source, /if \(!windowFocused\) \{/);
  assert.match(source, /showDesktopToast\(\{/);
  assert.ok(blurredWindowBranch);
  assert.doesNotMatch(blurredWindowBranch[1], /showInlineToast\(\{/);
  assert.match(
    source,
    /Failed to show detached desktop toast window for completed session/
  );
});

test('session notification sound is not blocked by push notification preference', () => {
  const source = readFrontendFile(
    'src/components/layout/ProjectWindowManager.tsx'
  );
  const soundIndex = source.indexOf('config?.notifications.sound_enabled');
  const pushIndex = source.indexOf('if (!config?.notifications.push_enabled)');

  assert.notEqual(soundIndex, -1);
  assert.notEqual(pushIndex, -1);
  assert.ok(soundIndex < pushIndex);
  assert.match(
    source,
    /playNotificationSound\(config\.notifications\.sound_file\)/
  );
  assert.match(source, /Failed to play session notification sound/);
});

test('default notification sound is phone vibration', () => {
  const configSource = readRepoFile(
    'crates/services/src/services/config/versions/v2.rs'
  );
  const soundPath = path.join(repoRoot, 'assets/sounds/phone-vibration.wav');

  assert.match(configSource, /sound_file:\s*SoundFile::PhoneVibration/);
  assert.match(
    configSource,
    /SoundFile::PhoneVibration => "phone-vibration\.wav"/
  );
  assert.ok(fs.existsSync(soundPath));
});

test('desktop toast window keeps a dedicated route, window, and ready handshake', () => {
  const appSource = readFrontendFile('src/App.tsx');
  const desktopToastSource = readFrontendFile(
    'src/components/desktop-toast/DesktopToastWindow.tsx'
  );
  const rustSource = readRepoFile('src-tauri/src/commands/desktop_toast.rs');
  const capabilitySource = readRepoFile('src-tauri/capabilities/default.json');

  assert.match(appSource, /if \(location\.pathname === '\/desktop-toast'\)/);
  assert.match(appSource, /<DesktopToastAppContent \/>/);
  assert.match(
    desktopToastSource,
    /tauriInvoke<DesktopToastPayload\[\]>\(\s*'desktop_toast_window_ready'/
  );
  assert.match(desktopToastSource, /tauriInvoke\('activate_desktop_toast',/);
  assert.ok(
    desktopToastSource.indexOf('tauriListen<DesktopToastPayload>(') <
      desktopToastSource.indexOf('desktop_toast_window_ready')
  );
  assert.match(
    desktopToastSource,
    /const \[isHydrated, setIsHydrated\] = useState\(false\)/
  );
  assert.match(
    desktopToastSource,
    /if \(!isHydrated \|\| toasts\.length > 0\)/
  );
  assert.match(
    rustSource,
    /DESKTOP_TOAST_WINDOW_LABEL: &str = "desktop-toast"/
  );
  assert.match(rustSource, /pub async fn desktop_toast_window_ready\(/);
  assert.match(rustSource, /WebviewUrl::App\("\/desktop-toast"\.into\(\)\)/);
  assert.match(rustSource, /\.background_color\(Color\(0, 0, 0, 0\)\)/);
  assert.match(
    rustSource,
    /set_background_color\(Some\(Color\(0, 0, 0, 0\)\)\)/
  );
  assert.match(capabilitySource, /"desktop-toast"/);
});
