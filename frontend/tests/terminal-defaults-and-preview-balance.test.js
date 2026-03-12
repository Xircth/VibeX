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

test('终端默认高度为 300px', () => {
  const terminalPrefsSource = readFrontendFile('src/lib/terminalPreferences.ts');
  const ideLayoutSource = readFrontendFile('src/components/layout/IDELayout.tsx');
  const panelActionsSource = readFrontendFile(
    'src/contexts/PanelActionsContext.tsx'
  );

  assert.match(terminalPrefsSource, /DEFAULT_TERMINAL_PANEL_HEIGHT\s*=\s*300/);
  assert.match(ideLayoutSource, /DEFAULT_TERMINAL_PANEL_HEIGHT/);
  assert.match(panelActionsSource, /DEFAULT_TERMINAL_PANEL_HEIGHT/);
});

test('TerminalHeaderActions 使用统一 workspace key 和默认终端来源', () => {
  const source = readFrontendFile(
    'src/components/layout/panels/TerminalHeaderActions.tsx'
  );

  assert.doesNotMatch(source, /projectId\s*\|\|/);
  assert.match(source, /activeWorktreeId/);
  assert.match(source, /default_terminal_shell|getDefaultTerminalShell/);
  assert.match(source, /stopPropagation\(\)/);
});

test('通用设置页暴露默认终端设置项', () => {
  const source = readFrontendFile('src/pages/settings/GeneralSettings.tsx');

  assert.match(source, /default_terminal_shell/);
  assert.match(source, /默认终端|Default Terminal/);
});

test('文件预览打开逻辑采用有空占空、无空占少', () => {
  const source = readFrontendFile('src/contexts/PanelActionsContext.tsx');

  assert.match(source, /openFilePreview/);
  assert.match(source, /api\.isVisible/);
  assert.match(source, /panels\.length|count.*panel|sort\(|reduce\(/);
});

test('最新 Rust 配置包含 default_terminal_shell', () => {
  const source = readRepoFile('crates/services/src/services/config/mod.rs');
  const versionSource = readRepoFile(
    'crates/services/src/services/config/versions/v9.rs'
  );

  assert.match(source, /v9::Config|versions::v9::Config/);
  assert.match(versionSource, /default_terminal_shell/);
});
