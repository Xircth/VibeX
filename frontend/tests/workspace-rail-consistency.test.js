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

test('Workspace 左右工具栏共用宽度、表面与按钮交互', () => {
  const activityRail = readFile(
    'src/components/layout/WorkspaceActivityRail.tsx'
  );
  const rightPanelSidebar = readFile(
    'src/components/layout/RightPanelSidebar.tsx'
  );
  const styles = readFile('src/styles/legacy/index.css');

  assert.match(
    activityRail,
    /workspace-activity-rail workspace-divider-right relative flex w-9 shrink-0 flex-col items-center gap-0\.5 bg-secondary\/30 pt-2/
  );
  assert.match(
    rightPanelSidebar,
    /workspace-divider-left relative flex w-9 shrink-0 flex-col items-center gap-0\.5 bg-secondary\/30 pt-2/
  );
  assert.match(activityRail, /workspace-side-rail-button flex h-7 w-7/);
  assert.match(rightPanelSidebar, /workspace-side-rail-button flex h-7 w-7/);
  assert.match(rightPanelSidebar, /transport\.environment !== 'web'/);
  assert.match(styles, /\.workspace-side-rail-button:hover\s*\{/);
  assert.match(styles, /\.workspace-side-rail-button:active\s*\{/);
  assert.match(styles, /\.workspace-side-rail-button\.is-active\s*\{/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.workspace-side-rail-button\s*\{[\s\S]*?transition: none;/
  );
});

test('Workspace 右侧工具栏由 Dockview 外层布局固定持有', () => {
  const ideLayout = readFile('src/components/layout/IDELayout.tsx');
  const rightPanelContent = readFile(
    'src/components/layout/RightPanelContent.tsx'
  );

  assert.match(
    ideLayout,
    /import \{ RightPanelSidebar \} from '@\/components\/layout\/RightPanelSidebar';/
  );
  assert.match(
    ideLayout,
    /<\/RightPanelSlotContext\.Provider>[\s\S]*?effectiveActiveTab === 'workspace'[\s\S]*?<RightPanelSidebar \/>/
  );
  assert.doesNotMatch(rightPanelContent, /RightPanelSidebar/);
});

test('会话消息导航的基础与 Hover 宽度缩小为原来的 70%', () => {
  const styles = readFile('src/styles/conversation/conv-tools.css');

  assert.match(styles, /\.conv-message-nav-rail\s*\{[\s\S]*?width: 22\.4px;/);
  assert.match(styles, /\.conv-message-nav-tick\s*\{[\s\S]*?width: 22\.4px;/);
  assert.match(
    styles,
    /\.conv-message-nav-tick::after\s*\{[\s\S]*?width: 8\.4px;/
  );
  assert.match(
    styles,
    /\.conv-message-nav-tick:hover::after,[\s\S]*?width: 19\.6px;/
  );
});

test('会话消息导航与用户消息的间隔缩小 30%', () => {
  const styles = readFile('src/styles/conversation/conv-tools.css');

  assert.match(
    styles,
    /\.conv-thread-content\s*\{[\s\S]*?padding-right: 25\.48px;/
  );
});
