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

test('预览成功状态与 Companion 就绪状态分离', () => {
  const source = readFrontendFile('src/components/panels/PreviewPanel.tsx');
  const readyContent = readFrontendFile('src/components/tasks/TaskDetails/preview/ReadyContent.tsx');

  assert.match(source, /const\s*\[previewLoaded,\s*setPreviewLoaded\]\s*=\s*useState\(false\)/);
  assert.match(source, /const\s*\[companionReady,\s*setCompanionReady\]\s*=\s*useState\(false\)/);
  assert.match(source, /loadingTimeFinished\s*&&\s*!previewLoaded/);
  assert.match(
    readyContent,
    /onIframeLoad\?:\s*\(iframe:\s*HTMLIFrameElement\s*\|\s*null\)\s*=>\s*void/
  );
  assert.match(readyContent, /onLoad=\{\(\) => onIframeLoad\?\.\(iframeRef\.current\)\}/);
});

test('右侧边栏启动开发服务器后不再重复创建日志标签', () => {
  const source = readFrontendFile('src/components/layout/RightPanelSidebar.tsx');

  assert.doesNotMatch(source, /generateTerminalTabId/);
  assert.doesNotMatch(source, /addSession\(/);
  assert.doesNotMatch(source, /PANEL_IDS\.TERMINAL, 'Terminal'/);
});

test('Companion 安装入口改为本地安装与自动接入', () => {
  const noServerContent = readFrontendFile('src/components/tasks/TaskDetails/preview/NoServerContent.tsx');
  const helper = readFrontendFile('src/utils/installWebCompanion.ts');
  const api = readFrontendFile('src/lib/api.ts');
  const backend = readRepoFile('src-tauri/src/commands/workspaces.rs');
  const tauri = readRepoFile('src-tauri/src/lib.rs');

  assert.doesNotMatch(noServerContent, /createAndStart\.mutate/);
  assert.match(noServerContent, /installWebCompanion/);
  assert.match(helper, /VibeKanbanWebCompanion/);
  assert.match(helper, /src\/main\.(tsx|jsx|ts|js)/);
  assert.match(api, /installWebCompanion:\s*async/);
  assert.match(backend, /pub async fn install_web_companion/);
  assert.match(tauri, /commands::workspaces::install_web_companion/);
});
