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

test('Toolbar 左上角 Logo 使用仅图标模式并保持首页链接', () => {
  const source = readFile('src/components/layout/Toolbar.tsx');

  assert.match(source, /Link to="\/local-projects"/);
  assert.match(source, /<Logo\s+showText=\{false\}\s*\/?>/);
});

test('右栏默认宽度初始化为 420px', () => {
  const source = readFile('src/stores/useLayoutStore.ts');

  assert.match(source, /const\s+DEFAULT_RIGHT_PANEL_WIDTH\s*=\s*420/);
});

test('默认布局显式创建 bottom 与 center-2 分组', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /id:\s*GROUP_IDS\.BOTTOM/);
  assert.match(source, /id:\s*GROUP_IDS\.CENTER_2/);
  assert.match(source, /locked:\s*'no-drop-target'/);
});

test('终端拖拽与终端栏拖入在 DnD guard 中被禁止', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /draggedPanelId\s*===\s*PANEL_IDS\.TERMINAL/);
  assert.match(source, /targetGroup\.id\s*===\s*GROUP_IDS\.BOTTOM/);
  assert.match(source, /event\.preventDefault\(\)/);
});

test('中2列显隐逻辑使用显式 center-2 group', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /id:\s*GROUP_IDS\.CENTER_2/);
  assert.match(source, /referenceGroup:\s*center2Group|referenceGroup:\s*targetGroup|direction:\s*'within'/);
});
