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

test('布局控制改为基于稳定 group id 切换中1与中2', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /getGroup\(GROUP_IDS\.CENTER_1\)/);
  assert.match(source, /getGroup\(GROUP_IDS\.CENTER_2\)/);
  assert.doesNotMatch(source, /const\s+group\s*=\s*centerGroups\[0\]/);
});

test('默认布局显式绑定中1 group id 且左栏默认宽度为 300', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /GROUP_IDS\.CENTER_1/);
  assert.match(source, /initialWidth:\s*300/);
});

test('中1中2预览分配遵从有空占空、无空占少，并优先中1', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /chooseCenterGroupForNewPanel|selectCenterGroupForNewPanel/);
  assert.match(source, /GROUP_IDS\.CENTER_1/);
  assert.match(source, /GROUP_IDS\.CENTER_2/);
  assert.match(source, /countContentPanels/);
  assert.doesNotMatch(source, /referenceGroup:\s*centerGroups\[0\]/);
});

test('左栏允许手动拖动宽度，不会在布局变更后被强制压回 300', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /maxLeftWidth/);
  assert.doesNotMatch(source, /Math\.min\(leftWidth,\s*300\)/);
});

test('预览区恢复选择元素与 DevTools 按钮', () => {
  const source = readFile('src/components/tasks/TaskDetails/preview/ReadyContent.tsx');

  assert.match(source, /onToggleSelectMode\??/);
  assert.match(source, /onToggleDevTools\??/);
  assert.match(source, /选择元素作为内容|select element as content/i);
  assert.match(source, /切换 DevTools|toggle devtools/i);
});

test('Companion 提示可关闭且安装后有成功或失败反馈', () => {
  const source = readFile('src/components/panels/PreviewPanel.tsx');

  assert.match(source, /isCompanionHelpDismissed/);
  assert.match(source, /setIsCompanionHelpDismissed\(true\)/);
  assert.match(source, /companionInstallFeedback/);
  assert.match(source, /onSuccess:/);
  assert.match(source, /onError:/);
});

test('开发服务器启动错误会显示可见错误弹窗', () => {
  const source = readFile('src/components/layout/RightPanelSidebar.tsx');

  assert.match(source, /showStartErrorDialog|setShowStartErrorDialog/);
  assert.match(source, /<Dialog\s+open=\{showStartErrorDialog\}/);
  assert.match(source, /startError/);
});

test('git 管理器切换与文件管理器一样走稳定左栏显隐逻辑', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /const\s+toggleGitPanel\s*=\s*useCallback/);
  assert.match(source, /leftGroup\?\.api\.isVisible/);
  assert.match(source, /resolvedLeftGroup/);
});

test('workspace 页面进入时会自动自愈文件管理器与终端布局', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /ensureWorkspacePanelsVisible|healWorkspaceLayout/);
  assert.match(source, /PANEL_IDS\.FILE_TREE/);
  assert.match(source, /PANEL_IDS\.TERMINAL/);
  assert.match(source, /activeWorktreeId/);
});

test('终端面板移除无作用滚动条的外层 overflow', () => {
  const source = readFile('src/components/panels/DockviewTerminalPanel.tsx');

  assert.match(source, /min-h-0/);
  assert.doesNotMatch(source, /w-24 bg-secondary border-l border-border overflow-y-auto flex flex-col gap-0/);
});
