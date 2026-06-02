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

test('main window close is intercepted and routed to the frontend choice dialog', () => {
  const tauriSource = readRepoFile('src-tauri/src/lib.rs');

  assert.match(tauriSource, /MAIN_WINDOW_CLOSE_REQUESTED_EVENT/);
  assert.match(tauriSource, /WindowEvent::CloseRequested/);
  assert.match(tauriSource, /api\.prevent_close\(\)/);
  assert.match(tauriSource, /emit\(MAIN_WINDOW_CLOSE_REQUESTED_EVENT/);
  assert.match(tauriSource, /async fn exit_app/);
  assert.match(tauriSource, /app\.exit\(0\)/);
});

test('app shows a centered close-behavior dialog with saved-choice actions', () => {
  const appSource = readFrontendFile('src/App.tsx');
  const apiSource = readFrontendFile('src/lib/api/misc.ts');

  assert.match(appSource, /MainWindowCloseToastBridge/);
  assert.match(appSource, /main-window-close-requested/);
  assert.match(appSource, /MAIN_WINDOW_CLOSE_BEHAVIOR_KEY/);
  assert.match(appSource, /vibex\.mainWindowCloseBehavior/);
  assert.match(appSource, /fixed inset-0 z-\[10000\]/);
  assert.match(appSource, /aria-modal="true"/);
  assert.match(appSource, /type="checkbox"/);
  assert.match(appSource, /checked=\{rememberBehavior\}/);
  assert.match(appSource, /desktopApi\.exitApp\(\)/);
  assert.match(appSource, /getCurrentWindow\(\)\.minimize\(\)/);
  assert.match(apiSource, /exitApp: async/);
  assert.match(apiSource, /tauriInvoke<void>\('exit_app'\)/);
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
