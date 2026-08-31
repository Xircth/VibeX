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

test('layout actions choose editor groups from stable editor-group helpers', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /const\s+getEditorGroups\s*=\s*useCallback/);
  assert.match(source, /compareEditorGroups/);
  assert.match(source, /getNextEditorGroupId/);
  assert.doesNotMatch(source, /centerGroups\[0\]/);
});

test('default workspace layout keeps explicit group ids and current left width', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /GROUP_IDS/);
  assert.match(source, /LEFT_PANEL_DEFAULT_WIDTH:\s*220/);
});

test('new panels open in the active editor group without first-group fallback', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /getActiveEditorGroup/);
  assert.match(
    source,
    /getEditorGroups\(dockviewApi\)\[0\] \?\? ensureWelcomeEditorGroup\(\)/
  );
  assert.match(source, /referenceGroup:\s*targetGroup/);
  assert.doesNotMatch(source, /referenceGroup:\s*centerGroups\[0\]/);
});

test('left sidebar width remains user-resizable instead of being forced back to 300', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /maxLeftWidth/);
  assert.doesNotMatch(source, /Math\.min\(leftWidth,\s*300\)/);
});

test('right sidebar network button removes the old dev-server config dialog and uses status coloring', () => {
  const source = readFile('src/components/layout/RightPanelSidebar.tsx');

  assert.doesNotMatch(source, /Configure Dev Server/);
  assert.doesNotMatch(source, /showStartErrorDialog|setShowStartErrorDialog/);
  assert.doesNotMatch(source, /showDevConfig|setShowDevConfig/);
  assert.match(
    source,
    /const hasRunningDevServer = runningDevServers\.length > 0/
  );
  assert.match(source, /const hasFailedDevServer = devServerProcesses\.some/);
  assert.match(source, /text-sky-600/);
  assert.match(source, /text-destructive/);
});

test('git manager toggle shares the stable left-sidebar switching path', () => {
  const source = readFile('src/contexts/PanelActionsContext.tsx');
  const layoutSource = readFile('src/components/layout/IDELayout.tsx');
  const activityRail = readFile(
    'src/components/layout/WorkspaceActivityRail.tsx'
  );

  assert.match(source, /const\s+toggleGitPanel\s*=\s*useCallback/);
  assert.match(source, /toggleLeftDockPanel\(PANEL_IDS\.GIT\)/);
  assert.match(layoutSource, /leftGroup\?\.api\.isVisible/);
  assert.match(activityRail, /toggleGitPanel/);
});

test('workspace entry heals left dock and terminal layout visibility', () => {
  const source = readFile('src/components/layout/IDELayout.tsx');

  assert.match(source, /ensureWorkspacePanelsVisible|healWorkspaceLayout/);
  assert.match(source, /getDefaultActivityRailPanelId/);
  assert.match(source, /LEFT_PANEL_IDS/);
  assert.match(source, /PANEL_IDS\.TERMINAL/);
  assert.match(source, /activeWorktreeId/);
});

test('terminal panel avoids the obsolete outer overflow wrapper', () => {
  const source = readFile('src/components/panels/DockviewTerminalPanel.tsx');

  assert.match(source, /min-h-0/);
  assert.doesNotMatch(
    source,
    /w-24 bg-secondary border-l border-border overflow-y-auto flex flex-col gap-0/
  );
});

test('recent project delete confirmation stays compact', () => {
  const source = readFile('src/components/welcome/WelcomePage.tsx');
  const projectCardSource = readFile('src/components/projects/ProjectCard.tsx');
  const projectDetailSource = readFile(
    'src/components/projects/ProjectDetail.tsx'
  );
  const projectDeleteUiSource = readFile('src/lib/projectDeleteUi.ts');
  const confirmSource = readFile(
    'src/components/dialogs/shared/ConfirmDialog.tsx'
  );

  assert.match(source, /PROJECT_DELETE_CONFIRM_CLASSNAME/);
  assert.match(source, /PROJECT_DELETE_TOAST_OPTIONS/);
  assert.match(projectCardSource, /PROJECT_DELETE_TOAST_OPTIONS/);
  assert.match(projectDetailSource, /PROJECT_DELETE_TOAST_OPTIONS/);
  assert.match(projectDeleteUiSource, /PROJECT_DELETE_CONFIRM_CLASSNAME/);
  assert.match(projectDeleteUiSource, /PROJECT_DELETE_CONFIRM_STYLE/);
  assert.match(projectDeleteUiSource, /PROJECT_DELETE_TOAST_OPTIONS/);
  assert.match(projectDeleteUiSource, /!w-\[404px\] !max-w-\[404px\]/);
  assert.match(projectDeleteUiSource, /width:\s*'404px'/);
  assert.match(projectDeleteUiSource, /maxWidth:\s*'calc\(100vw - 32px\)'/);
  assert.match(projectDeleteUiSource, /vu-project-delete-toast/);
  assert.match(projectDeleteUiSource, /\['--width' as string\]:\s*'224px'/);
  assert.match(confirmSource, /contentStyle\?: CSSProperties/);
  assert.match(confirmSource, /<Dialog[\s\S]*style=\{contentStyle\}/);
  assert.doesNotMatch(
    confirmSource,
    /<DialogContent[\s\S]*style=\{contentStyle\}/
  );
  assert.match(source, /PROJECT_DELETE_TOAST_OPTIONS/);
  assert.match(
    readFile('src/styles/legacy/index.css'),
    /\[data-sonner-toast\]\.vu-project-delete-toast/
  );
  assert.match(
    readFile('src/styles/legacy/index.css'),
    /--width:\s*224px !important/
  );
  assert.match(
    readFile('src/styles/legacy/index.css'),
    /right:\s*7px !important/
  );
  assert.match(
    confirmSource,
    /contentClassName \?\? '!max-w-\[360px\] sm:!max-w-\[360px\]'/
  );
  assert.doesNotMatch(source, /contentClassName:\s*'sm:max-w-\[224px\]'/);
  assert.doesNotMatch(source, /contentClassName:\s*'sm:max-w-\[320px\]'/);
  assert.doesNotMatch(confirmSource, /cn\('sm:max-w-\[360px\]'/);
});

test('x icon close buttons avoid the blue focus ring', () => {
  const source = readFile('src/styles/legacy/index.css');

  assert.match(source, /button:has\(svg\.lucide-x\):focus-visible/);
  assert.match(source, /box-shadow:\s*none !important/);
});
