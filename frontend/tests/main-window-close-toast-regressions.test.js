import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const frontendRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('main window close hides the window and dock reopen restores it', () => {
  const tauriSource = readRepoFile('src-tauri/src/lib.rs');
  const traySource = readRepoFile('src-tauri/src/tray.rs');

  assert.match(tauriSource, /WindowEvent::CloseRequested/);
  assert.match(tauriSource, /api\.prevent_close\(\)/);
  assert.match(tauriSource, /hide_main_window/);
  assert.match(tauriSource, /RunEvent::Reopen/);
  assert.match(tauriSource, /show_main_window/);
  assert.doesNotMatch(tauriSource, /MAIN_WINDOW_CLOSE_REQUESTED_EVENT/);
  assert.match(traySource, /fn hide_main_window/);
  assert.match(traySource, /fn show_main_window/);
  assert.match(tauriSource, /async fn exit_app/);
  assert.match(traySource, /TRAY_MENU_ID_QUIT => app\.exit\(0\)/);
});

test('frontend does not ask whether closing the main window should quit', () => {
  const appSource = readFrontendFile('src/App.tsx');
  const apiSource = readFrontendFile('src/lib/api/misc.ts');

  assert.doesNotMatch(appSource, /MainWindowCloseToastBridge/);
  assert.doesNotMatch(appSource, /main-window-close-requested/);
  assert.doesNotMatch(appSource, /mainWindowCloseBehavior/);
  assert.doesNotMatch(appSource, /closeBehaviorTitle/);
  assert.match(apiSource, /exitApp: async/);
  assert.match(apiSource, /backendCall<void>\('exit_app'\)/);
});

test('local dependency update notification is Chinese, grouped, and minimum-version gated', () => {
  const appSource = readFrontendFile('src/App.tsx');

  assert.match(appSource, /localToolNeedsUpdatePrompt/);
  assert.match(appSource, /compareVersionLike/);
  assert.match(appSource, /visibleTools\.filter\(\s*localToolNeedsUpdatePrompt\s*\)/);
  assert.match(appSource, /toast\.custom/);
  assert.match(appSource, /有 \$\{tools\.length\} 个依赖需要更新/);
  assert.match(appSource, /当前版本：/);
  assert.match(appSource, /最低支持：/);
  assert.match(appSource, /正在更新本地 Agent 依赖/);
  assert.match(appSource, /VibeX \$\{status\.app\.latest_version\} 可更新/);
  assert.match(appSource, /打开发布页/);
  assert.doesNotMatch(appSource, /Updating local dependency/);
  assert.doesNotMatch(appSource, /local dependency needs an update/);
  assert.doesNotMatch(appSource, /Open release/);
});

test('local dependency update notification opts out of the default sonner shell and constrains expanded details', () => {
  const appSource = readFrontendFile('src/App.tsx');
  const sonnerSource = readFrontendFile('src/components/ui/sonner.tsx');
  const stylesSource = readFrontendFile('src/styles/legacy/index.css');

  assert.match(appSource, /toast\.custom\(/);
  assert.match(appSource, /unstyled:\s*true/);
  assert.match(appSource, /vu-local-dependency-toast-shell/);
  assert.match(sonnerSource, /vu-sonner-toast/);
  assert.match(stylesSource, /vu-local-dependency-toast-shell/);
  assert.match(stylesSource, /overflow:\s*visible/);
  assert.match(appSource, /max-h-\[min\(60vh,320px\)\]/);
  assert.match(appSource, /overflow-y-auto/);
});
