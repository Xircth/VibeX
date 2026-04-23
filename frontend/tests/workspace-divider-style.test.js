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

test('Workspace 主区域分隔线统一使用共享 divider 样式', () => {
  const ideLayout = readFile('src/components/layout/IDELayout.tsx');
  const rightPanelSidebar = readFile(
    'src/components/layout/RightPanelSidebar.tsx'
  );
  const branchInfoHeader = readFile(
    'src/components/layout/BranchInfoHeader.tsx'
  );
  const statusBar = readFile('src/components/layout/StatusBar.tsx');

  assert.match(ideLayout, /className="workspace-shell flex h-full w-full flex-col"/);
  assert.match(ideLayout, /workspace-divider-bottom z-10 shrink-0 bg-background/);
  assert.match(ideLayout, /workspace-divider-right flex w-10 shrink-0/);
  assert.match(ideLayout, /workspace-resize-handle relative z-20 w-px shrink-0/);
  assert.match(rightPanelSidebar, /workspace-divider-left/);
  assert.match(branchInfoHeader, /workspace-divider-bottom/);
  assert.match(statusBar, /workspace-divider-top/);
});

test('Dockview 横竖分隔条统一使用 workspace divider 变量', () => {
  const source = readFile('src/styles/dockview-ayu.css');

  assert.match(source, /--workspace-divider-color:/);
  assert.match(source, /--workspace-divider-hover:/);
  assert.match(source, /\.workspace-resize-handle \{/);
  assert.match(source, /\.workspace-resize-handle::before \{/);
  assert.match(source, /width: 4px;[\s\S]*height: 21px;/);
  assert.match(
    source,
    /dv-split-view-container\.dv-horizontal[\s\S]*background-color: var\(--workspace-divider-color, var\(--dv-sash-color\)\)/
  );
  assert.match(
    source,
    /dv-split-view-container\.dv-horizontal[\s\S]*dv-sash\.dv-enabled::after[\s\S]*width: 4px;[\s\S]*height: 21px;/
  );
  assert.match(
    source,
    /dv-split-view-container\.dv-vertical[\s\S]*height: 1px;[\s\S]*background-color: var\(--workspace-divider-color, var\(--dv-sash-color\)\)/
  );
  assert.match(
    source,
    /dv-split-view-container\.dv-vertical[\s\S]*dv-sash\.dv-enabled::after[\s\S]*width: 21px;[\s\S]*height: 4px;/
  );
  assert.match(
    source,
    /dv-split-view-container\.dv-vertical[\s\S]*dv-sash\.dv-enabled:hover[\s\S]*height: 3px;[\s\S]*dv-sash\.dv-enabled:hover::after[\s\S]*height: 6px;/
  );
});
