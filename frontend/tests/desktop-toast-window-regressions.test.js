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

test('session completion notifications use the detached desktop toast when main window is unfocused', () => {
  const source = readFrontendFile(
    'src/components/layout/ProjectWindowManager.tsx'
  );
  const deliverySource = readFrontendFile(
    'src/components/layout/sessionCompletionNotification.ts'
  );

  assert.match(source, /'desktop-conversation-finished'/);
  assert.match(source, /desktopApi\.isMainWindowFocused\(\)/);
  assert.match(source, /summary\.id === payload\.sessionId/);
  assert.doesNotMatch(source, /previousWorkspaceStateRef/);
  assert.doesNotMatch(source, /dateTimestamp/);
  assert.match(source, /showDesktopToast\(\{/);
  assert.match(deliverySource, /if \(windowFocused\) return;/);
  assert.doesNotMatch(source, /showInlineToast/);
  assert.doesNotMatch(source, /toast\.custom/);
});

test('session notification sound is not blocked by push notification preference', () => {
  const source = readFrontendFile(
    'src/components/layout/sessionCompletionNotification.ts'
  );
  const soundIndex = source.indexOf('if (soundEnabled)');
  const pushIndex = source.indexOf('if (pushEnabled)');

  assert.notEqual(soundIndex, -1);
  assert.notEqual(pushIndex, -1);
  assert.ok(soundIndex < pushIndex);
  assert.match(source, /playSound\(soundFile\)/);
  assert.match(source, /showPush\(\)/);
  assert.match(source, /Promise\.all\(deliveries\)/);
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
  const routeSource = readFrontendFile('src/appRouteMode.ts');
  const desktopToastSource = readFrontendFile(
    'src/components/desktop-toast/DesktopToastWindow.tsx'
  );
  const rustSource = readRepoFile('src-tauri/src/commands/desktop_toast.rs');
  const capabilitySource = readRepoFile('src-tauri/capabilities/default.json');

  assert.match(routeSource, /pathname === '\/desktop-toast'/);
  assert.match(appSource, /<DesktopToastAppContent \/>/);
  assert.match(appSource, /<DesktopToastWindow \/>/);
  assert.match(
    desktopToastSource,
    /backendCall<DesktopToastPayload\[\]>\(\s*'desktop_toast_window_ready'/
  );
  assert.match(desktopToastSource, /backendCall\('activate_desktop_toast',/);
  assert.ok(
    desktopToastSource.indexOf('backendListen<DesktopToastPayload>(') <
      desktopToastSource.indexOf('desktop_toast_window_ready')
  );
  assert.match(desktopToastSource, /<Logo showText=\{false\} \/>/);
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
  assert.match(rustSource, /pub async fn is_main_window_focused\(/);
  assert.match(rustSource, /app\.webview_windows\(\)/);
  assert.match(rustSource, /label == DESKTOP_TOAST_WINDOW_LABEL/);
  assert.match(rustSource, /window\.is_focused\(\)/);
  assert.match(rustSource, /WebviewUrl::App\("\/desktop-toast"\.into\(\)\)/);
  assert.match(rustSource, /\.icon\(crate::load_app_icon\(\)/);
  assert.match(rustSource, /position_desktop_toast_window/);
  assert.match(rustSource, /\.background_color\(Color\(0, 0, 0, 0\)\)/);
  assert.match(
    rustSource,
    /set_background_color\(Some\(Color\(0, 0, 0, 0\)\)\)/
  );
  assert.match(capabilitySource, /"desktop-toast"/);
});

test('opening a desktop notification swaps its session into the execution area', () => {
  const bridgeSource = readFrontendFile(
    'src/components/layout/WorkspaceLayout.tsx'
  );
  const appSource = readFrontendFile('src/App.tsx');
  const layoutSource = readFrontendFile('src/lib/kanbanSessionLayout.ts');
  const contextSource = readFrontendFile(
    'src/contexts/KanbanSessionContext.tsx'
  );

  assert.match(bridgeSource, /activateExecutionSession\(\{/);
  assert.match(bridgeSource, /state\.focusRequests\[projectId\]/);
  assert.match(bridgeSource, /!isLayoutHydrated/);
  assert.match(appSource, /getCurrentWindow\(\)\.label === 'main'/);
  assert.match(layoutSource, /function activateSessionInExecutionArea/);
  assert.match(layoutSource, /rightSession: nextSession/);
  assert.match(layoutSource, /state\.rightSession/);
  assert.match(
    contextSource,
    /activateSessionInExecutionArea\(current, session, \{\s*canUseRightPanel: true/
  );
});
