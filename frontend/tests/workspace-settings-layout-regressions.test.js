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

test('workspace can collapse the editor and terminal area while expanding the right panel', () => {
  const layoutStore = readFile('src/stores/useLayoutStore.ts');
  const ideLayout = readFile('src/components/layout/IDELayout.tsx');

  assert.match(layoutStore, /isEditorAreaVisible/);
  assert.match(layoutStore, /toggleEditorArea/);
  assert.match(layoutStore, /version:\s*18/);
  assert.match(ideLayout, /toggleEditorArea/);
  assert.match(ideLayout, /isWorkspaceEditorAreaCollapsed/);
  assert.match(ideLayout, /隐藏编辑区和终端区/);
  assert.match(
    ideLayout,
    /\? 'z-20 min-w-0 flex-1 overflow-hidden bg-background'/
  );
  assert.match(ideLayout, /!isWorkspaceEditorAreaCollapsed \? \(/);
});

test('settings navigation is reorganized into the requested top-level sections', () => {
  const layout = readFile('src/pages/settings/SettingsLayout.tsx');
  const app = readFile('src/App.tsx');
  const exports = readFile('src/pages/settings/index.ts');

  assert.match(layout, /label:\s*'Agent'/);
  assert.match(layout, /label:\s*'技能'/);
  assert.match(layout, /label:\s*'MCP'/);
  assert.match(layout, /label:\s*'交互'/);
  assert.match(layout, /label:\s*'编辑'/);
  assert.match(layout, /label:\s*'外观'/);
  assert.match(layout, /label:\s*'系统'/);
  assert.match(app, /path="appearance" element=\{<AppearanceSettings \/>\}/);
  assert.match(exports, /AppearanceSettings/);
});

test('settings visual treatment uses lighter cards and clearer controls', () => {
  const styles = readFile('src/styles/legacy/index.css');
  const system = readFile('src/pages/settings/SystemSettings.tsx');
  const editor = readFile('src/pages/settings/EditorSettings.tsx');

  assert.match(styles, /\.settings-page \.settings-card/);
  assert.match(styles, /border-width:\s*1px/);
  assert.match(styles, /height:\s*2rem/);
  assert.match(styles, /min-height:\s*2rem/);
  assert.match(styles, /user-select:\s*none/);
  assert.match(styles, /--tw-ring-shadow:\s*0 0 #0000 !important/);
  assert.match(styles, /box-shadow:\s*0 1px 2px/);
  assert.match(styles, /button\[role='switch'\]\[data-state='unchecked'\]/);
  assert.match(
    readFile('src/components/ui/switch.tsx'),
    /props\.checked \? 'bg-primary'/
  );
  assert.match(styles, /--card:\s*0 0% 96%/);
  assert.doesNotMatch(system, /CLEAR_LOCAL_DATA_DESCRIPTION/);
  assert.doesNotMatch(
    system,
    /placeholder="例如：opencode\/minimax-m2\.5-free"/
  );
  assert.doesNotMatch(system, /title="外观"/);
  assert.doesNotMatch(system, /读取模型列表失败/);
  assert.match(system, /FALLBACK_OPENCODE_MODELS/);
  assert.match(system, /opencode\/gpt-5\.5/);
  assert.match(system, /<div className="space-y-7">/);
  assert.doesNotMatch(system, /components\/ui\/checkbox/);
  assert.match(system, /<Switch[\s\S]*settings-switch/);
  assert.doesNotMatch(system, /title="Git"/);
  assert.match(editor, /title="Git"/);
  assert.match(editor, /title="拉取请求"/);
  assert.doesNotMatch(editor, /components\/ui\/checkbox/);
  assert.match(
    editor,
    /<EditorAvailabilityIndicator[\s\S]*availability=\{editorAvailability\}/
  );
  assert.match(editor, /settings-switch/);
});
