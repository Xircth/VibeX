import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('布局 panel id 暴露独立的 dev-preview 标识', () => {
  const source = readFile('src/stores/useLayoutStore.ts');

  assert.match(source, /DEV_PREVIEW:\s*'dev-preview'/);
});

test('panel 注册表区分文件预览与开发预览组件', () => {
  const source = readFile('src/components/layout/panels/PanelRegistry.tsx');

  assert.match(
    source,
    /import DockviewPreviewPanel from '@\/components\/panels\/DockviewPreviewPanel';/
  );
  assert.match(source, /import\('\@\/components\/panels\/DockviewDevPreviewPanel'\)/);
  assert.match(source, /\[PANEL_IDS\.PREVIEW\]:\s*DockviewPreviewPanel/);
  assert.match(source, /\[PANEL_IDS\.DEV_PREVIEW\]:\s*LazyDevPreviewPanel/);
});

test('右侧边栏的开发预览入口打开 dev-preview panel', () => {
  const source = readFile('src/components/layout/RightPanelSidebar.tsx');

  assert.match(source, /openOrFocusPanel\(PANEL_IDS\.DEV_PREVIEW,\s*'Dev Preview'\)/);
});

test('Dockview 开发预览 panel 包装组件补齐预览所需上下文', () => {
  const source = readFile('src/components/panels/DockviewDevPreviewPanel.tsx');

  assert.match(source, /ExecutionProcessesProvider/);
  assert.match(source, /useTaskAttemptWithSession/);
  assert.match(source, /executionKey/);
  assert.match(source, /PreviewPanel/);
});
