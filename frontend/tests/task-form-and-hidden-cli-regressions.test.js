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

test('session creation form copy stays Chinese and keeps branch warning wiring', () => {
  const sessionCreationForm = readFrontendFile(
    'src/components/sessions/SessionCreationForm.tsx'
  );
  const terminalProfileControls = readFrontendFile(
    'src/components/tasks/TerminalProfileControls.tsx'
  );
  const agentSelector = readFrontendFile(
    'src/components/tasks/AgentSelector.tsx'
  );

  assert.match(sessionCreationForm, /创建方式/);
  assert.match(sessionCreationForm, /现有工作区/);
  assert.match(sessionCreationForm, /新工作区/);
  assert.match(sessionCreationForm, /工作区分支/);
  assert.match(sessionCreationForm, /会话名称（可选）/);
  assert.match(sessionCreationForm, /不填则使用首条消息自动命名/);
  assert.match(sessionCreationForm, /getWorkspaceBranchWarning/);
  assert.match(sessionCreationForm, /getWorkspaceBranchCheckoutHint/);
  assert.match(sessionCreationForm, /创建会话/);
  assert.match(sessionCreationForm, /'flex flex-wrap items-center gap-2'/);
  assert.match(terminalProfileControls, /flex flex-wrap items-center gap-2/);
  assert.match(agentSelector, /aria-label="选择代理"/);
  assert.doesNotMatch(sessionCreationForm, /Task Title|Auto Start|Update Task/);
});

test('tab context menu uses the current Chinese label and keeps the panel split wiring', () => {
  const layout = readFrontendFile('src/components/layout/IDELayout.tsx');
  const panelActions = readFrontendFile('src/contexts/PanelActionsContext.tsx');

  assert.match(layout, /在新的编辑区打开/);
  assert.doesNotMatch(layout, /Open in New Editor Group/);
  assert.match(panelActions, /referencePanel:\s*panel,/);
});

test('windows hidden cli helper wraps batch-based agent commands', () => {
  const processUtils = readRepoFile('crates/utils/src/process.rs');
  const claude = readRepoFile('crates/executors/src/executors/claude.rs');
  const codex = readRepoFile('crates/executors/src/executors/codex.rs');
  const slashCommands = readRepoFile(
    'crates/executors/src/executors/claude/slash_commands.rs'
  );
  const agentSettings = readRepoFile(
    'src-tauri/src/commands/agent_settings.rs'
  );
  const workspaces = readRepoFile('src-tauri/src/commands/workspaces.rs');

  assert.match(processUtils, /new_hidden_tokio_command/);
  assert.match(processUtils, /is_windows_batch_script/);
  assert.match(processUtils, /cmd\.exe/);
  assert.match(claude, /new_hidden_tokio_command/);
  assert.match(codex, /new_hidden_tokio_command/);
  assert.match(slashCommands, /new_hidden_tokio_command/);
  assert.match(agentSettings, /new_hidden_tokio_command/);
  assert.match(workspaces, /new_hidden_tokio_command/);
});
