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

function readWorkspaceCommandSource() {
  return [
    'src-tauri/src/commands/workspaces.rs',
    'src-tauri/src/commands/workspaces/types.rs',
    'src-tauri/src/commands/workspaces/workspace_sync.rs',
    'src-tauri/src/commands/workspaces/workspace_crud.rs',
    'src-tauri/src/commands/workspaces/git_operations.rs',
    'src-tauri/src/commands/workspaces/workspace_scripts.rs',
    'src-tauri/src/commands/workspaces/workspace_queries.rs',
    'src-tauri/src/commands/workspaces/pull_requests.rs',
    'src-tauri/src/commands/workspaces/pr_import.rs',
    'src-tauri/src/commands/workspaces/commit_commands.rs',
  ]
    .map(readRepoFile)
    .join('\n');
}

function readProviderRuntimeSource() {
  return [
    'src-tauri/src/commands/provider_runtime/mod.rs',
    'src-tauri/src/commands/provider_runtime/contract.rs',
    'src-tauri/src/commands/provider_runtime/runtime_config.rs',
    'src-tauri/src/commands/provider_runtime/claude_sdk.rs',
    'src-tauri/src/commands/provider_runtime/opencode_sdk.rs',
    'src-tauri/src/commands/provider_runtime/provider_text.rs',
    'src-tauri/src/commands/provider_runtime/provider_tools.rs',
    'src-tauri/src/commands/provider_runtime/token_usage.rs',
    'src-tauri/src/commands/provider_runtime/native_conversation.rs',
    'src-tauri/src/commands/provider_runtime/runtime_core.rs',
    'src-tauri/src/commands/provider_runtime/codex_app_server.rs',
    'src-tauri/src/commands/provider_runtime/provider_turns.rs',
    'src-tauri/src/commands/provider_runtime/history_commands.rs',
  ]
    .map(readRepoFile)
    .join('\n');
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

test('dev preview resolves workspace outside route params', () => {
  const previewPanel = readFrontendFile(
    'src/components/panels/PreviewPanel.tsx'
  );
  const dockviewDevPreviewPanel = readFrontendFile(
    'src/components/panels/DockviewDevPreviewPanel.tsx'
  );

  assert.match(previewPanel, /useOptionalKanbanSessionContext/);
  assert.match(previewPanel, /useWorktree/);
  assert.match(previewPanel, /panelWorkspaceId \?\?/);
  assert.match(previewPanel, /routeWorkspaceId \?\?/);
  assert.match(previewPanel, /visibleRightSession\?\.workspaceId \?\?/);
  assert.match(previewPanel, /activeWorktreeId \?\?/);
  assert.doesNotMatch(previewPanel, /const attemptId = workspaceId;/);

  assert.match(dockviewDevPreviewPanel, /visibleRightSession\?\.workspaceId/);
  assert.match(
    dockviewDevPreviewPanel,
    /<PreviewPanel workspaceId=\{workspaceId\} \/>/
  );
});

test('windows hidden cli helper wraps batch-based agent commands', () => {
  const processUtils = readRepoFile('crates/utils/src/process.rs');
  const acpTerminal = readRepoFile(
    'crates/executors/src/executors/acp/terminal.rs'
  );
  const acpHarness = readRepoFile(
    'crates/executors/src/executors/acp/harness.rs'
  );
  const codexAccount = readRepoFile('src-tauri/src/commands/codex_account.rs');
  const agentSettings = readRepoFile(
    'src-tauri/src/commands/agent_settings.rs'
  );
  const workspaces = readWorkspaceCommandSource();
  const providerRuntime = readProviderRuntimeSource();
  const opencodeBridge = readRepoFile('scripts/opencode-sdk-provider.mjs');

  assert.match(processUtils, /new_hidden_tokio_command/);
  assert.match(processUtils, /is_windows_batch_script/);
  assert.match(processUtils, /cmd\.exe/);
  assert.match(acpTerminal, /new_hidden_tokio_command/);
  assert.match(acpHarness, /new_hidden_tokio_command/);
  assert.match(codexAccount, /new_hidden_tokio_command/);
  assert.match(agentSettings, /new_hidden_tokio_command/);
  assert.match(workspaces, /new_hidden_tokio_command/);
  assert.match(providerRuntime, /new_provider_hidden_command/);
  assert.doesNotMatch(providerRuntime, /Command::new\(/);
  assert.match(opencodeBridge, /windowsHide:\s*true/);
  assert.match(opencodeBridge, /taskkill/);
});

test('codex profile controls preserve explicit model overrides', () => {
  const terminalProfileControls = readFrontendFile(
    'src/components/tasks/TerminalProfileControls.tsx'
  );
  const providerRuntime = readProviderRuntimeSource();

  assert.match(
    terminalProfileControls,
    /const currentModel = selectedProfile\.model \?\? currentConfig\.model;/
  );
  assert.match(
    terminalProfileControls,
    /const modelOverride =\s*selectedModel === variantConfig\.model \? null : selectedModel;/
  );
  assert.match(terminalProfileControls, /value=\{currentModel\}/);
  assert.match(terminalProfileControls, /model: modelOverride/);

  assert.match(providerRuntime, /"method": "turn\/queued"/);
  assert.match(providerRuntime, /CODEX_NATIVE_THREAD_SINKS/);
  assert.match(providerRuntime, /result\.get\("turn"\)/);
  assert.match(providerRuntime, /params\.get\("turn"\)/);
});

test('sent user message bubbles preserve mention and command chip styling', () => {
  const userMessage = readFrontendFile(
    'src/components/NormalizedConversation/UserMessage.tsx'
  );
  const wysiwyg = readFrontendFile('src/components/ui/wysiwyg.tsx');
  const fileReferenceNode = readFrontendFile(
    'src/components/ui/wysiwyg/nodes/file-reference-node.tsx'
  );
  const slashCommandNode = readFrontendFile(
    'src/components/ui/wysiwyg/nodes/slash-command-node.tsx'
  );
  const dollarCommandNode = readFrontendFile(
    'src/components/ui/wysiwyg/nodes/dollar-command-node.tsx'
  );

  assert.match(userMessage, /stripTagReferenceAppendix/);
  assert.match(userMessage, /const displayContent =/);
  assert.match(userMessage, /value=\{displayContent\}/);
  assert.match(userMessage, /initialContent=\{displayContent\}/);

  assert.match(wysiwyg, /SLASH_COMMAND_DISPLAY_TRANSFORMER/);
  assert.match(slashCommandNode, /SLASH_COMMAND_DISPLAY_TRANSFORMER/);
  assert.match(slashCommandNode, /\/\(\[A-Za-z\]\[A-Za-z0-9:_-\]\*\)/);
  assert.match(dollarCommandNode, /\\\$\(\[A-Za-z\]\[A-Za-z0-9:_-\]\*\)/);
  assert.match(fileReferenceNode, /return `@\$\{node\.__relativePath\}`;/);
  assert.match(fileReferenceNode, /@\(\[\^\\s#@\]\+\)/);
});

test('typeahead command menu commits mouse selections before focus cleanup', () => {
  const typeaheadMenu = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/typeahead-menu-components.tsx'
  );
  const dollarCommandTypeahead = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/dollar-command-typeahead-plugin.tsx'
  );
  const slashCommandTypeahead = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/slash-command-typeahead-plugin.tsx'
  );
  const fileTagTypeahead = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/file-tag-typeahead-plugin.tsx'
  );

  assert.match(typeaheadMenu, /const handleMouseDown = useCallback/);
  assert.match(typeaheadMenu, /event\.preventDefault\(\);/);
  assert.match(typeaheadMenu, /mouseSelectionRef\.current = true;/);
  assert.match(typeaheadMenu, /role="option"/);
  assert.doesNotMatch(typeaheadMenu, /border-l-2/);

  assert.match(
    dollarCommandTypeahead,
    /setRefElement=\{option\.setRefElement\}/
  );
  assert.match(
    slashCommandTypeahead,
    /setRefElement=\{option\.setRefElement\}/
  );
  assert.match(fileTagTypeahead, /setRefElement=\{option\.setRefElement\}/);
});
