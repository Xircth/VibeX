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

test('new task form copy is Chinese and auto-start controls can wrap', () => {
  const taskForm = readFrontendFile(
    'src/components/dialogs/tasks/TaskFormDialog.tsx'
  );
  const terminalProfileControls = readFrontendFile(
    'src/components/tasks/TerminalProfileControls.tsx'
  );
  const permissionSelector = readFrontendFile(
    'src/components/tasks/PermissionSelector.tsx'
  );
  const agentSelector = readFrontendFile(
    'src/components/tasks/AgentSelector.tsx'
  );

  assert.match(taskForm, /任务标题/);
  assert.match(taskForm, /如有需要可补充更多细节/);
  assert.match(taskForm, /加载分支中\.\.\./);
  assert.match(taskForm, /创建 Worktree/);
  assert.match(taskForm, /自动启动/);
  assert.match(
    taskForm,
    /className="w-full flex min-w-0 flex-wrap items-center gap-2"/
  );
  assert.match(
    terminalProfileControls,
    /flex flex-wrap items-center gap-2 flex-1 min-w-0/
  );
  assert.match(permissionSelector, /自动/);
  assert.match(permissionSelector, /询问/);
  assert.match(agentSelector, /编程代理/);
  assert.doesNotMatch(taskForm, /Drop images here|Task Title|Enter task title/);
  assert.doesNotMatch(taskForm, /Auto Start|Update Task|Discard unsaved changes/);
});

test('tab context menu uses Chinese label and splits with the panel object', () => {
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
  const agentSettings = readRepoFile('src-tauri/src/commands/agent_settings.rs');
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
