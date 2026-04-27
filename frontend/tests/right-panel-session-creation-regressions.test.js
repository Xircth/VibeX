import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('right panel session creation does not route through createSession query params', () => {
  const source = readFile('src/components/layout/RightPanelContent.tsx');

  assert.doesNotMatch(source, /\?createSession=1/);
  assert.doesNotMatch(source, /navigate\(/);
});

test('right panel session creation uses a local centered overlay form and creates sessions directly', () => {
  const source = readFile('src/components/layout/RightPanelContent.tsx');
  const promptSource = readFile(
    'src/components/layout/RightPanelNewSessionPrompt.tsx'
  );

  assert.doesNotMatch(source, /<Popover/);
  assert.match(source, /function CreateSessionOverlay/);
  assert.match(source, /<SessionCreationForm/);
  assert.match(source, /sessionsApi\.createProject/);
  assert.match(source, /placeCreatedSession\(/);
  assert.match(
    source,
    /absolute inset-0 z-10 flex items-center justify-center bg-background\/86 p-6 backdrop-blur-sm/
  );
  assert.match(source, /<RightPanelNewSessionPrompt/);
  assert.match(source, /onCreateSession=\{openCreateSessionOverlay\}/);
  assert.match(promptSource, /justify-center/);
  assert.match(promptSource, /当前工作区还没有会话/);
  assert.match(promptSource, /新建会话/);
  assert.doesNotMatch(source, /Create a new session to get started\./);
  assert.doesNotMatch(source, />New Session</);
  assert.match(source, /onCancel=\{onClose\}/);
  assert.match(source, /useTaskAttempt\(fallbackWorkspaceId\)/);
  assert.match(
    source,
    /useTaskAttempt\(\s*lastActiveWorkspaceId \?\? undefined\s*\)/
  );
  assert.match(source, /workspaceBranchOptions/);
  assert.match(source, /resolveWorkspaceBranchSelection/);
  assert.match(source, /workspaceSelection\.workspaceId/);
  assert.match(source, /workspaceSelection\.branch/);
  assert.match(source, /useRepoBranches\(primaryRepo\?\.id/);
  assert.match(source, /if \(!isCreateOverlayOpen \|\| isLoadingWorktrees\)/);
});

test('workspace right-panel new-session triggers route through the shared overlay context instead of the inline input form', () => {
  const panelSource = readFile('src/components/layout/RightPanelContent.tsx');
  const contextSource = readFile(
    'src/contexts/RightPanelSessionCreationContext.tsx'
  );
  const conversationSource = readFile(
    'src/components/kanban/KanbanSessionConversationView.tsx'
  );
  const followUpSource = readFile('src/components/tasks/TaskFollowUpSection.tsx');
  const promptSource = readFile(
    'src/components/layout/RightPanelNewSessionPrompt.tsx'
  );

  assert.match(contextSource, /RightPanelSessionCreationProvider/);
  assert.match(contextSource, /openCreateSessionOverlay/);
  assert.match(
    panelSource,
    /<RightPanelSessionCreationProvider\s+value=\{\{ openCreateSessionOverlay \}\}/
  );
  assert.match(
    conversationSource,
    /if \(rightPanelSessionCreation\) \{\s*rightPanelSessionCreation\.openCreateSessionOverlay\(\);/
  );
  assert.match(
    followUpSource,
    /const isNewSessionConfigVisible =\s*isNewSessionMode && !rightPanelSessionCreation;/
  );
  assert.match(
    followUpSource,
    /if \(rightPanelSessionCreation\) \{\s*rightPanelSessionCreation\.openCreateSessionOverlay\(\);/
  );
  assert.match(
    conversationSource,
    /autoSelectFirstSession: Boolean\(attempt\.session\?\.id\)/
  );
  assert.match(
    conversationSource,
    /!activeSession &&\s*\(!attempt\.session\?\.id \|\| sessionState\.sessions\.length === 0\)/
  );
  assert.match(conversationSource, /<RightPanelNewSessionPrompt/);
  assert.match(promptSource, /className=\{cn\(\s*'flex h-full min-h-0 flex-col items-center justify-center/);
});

test('workspace route binds the right panel to the current workspace instead of reusing a stale persisted right-session', () => {
  const source = readFile('src/components/layout/RightPanelContent.tsx');

  assert.match(source, /const isWorkspaceRoute = effectiveActiveTab === 'workspace' && !!workspaceId;/);
  assert.match(
    source,
    /\{isWorkspaceRoute && workspaceId \? \(\s*<div className="h-full min-h-0 overflow-hidden">\s*<KanbanSessionConversationView\s*workspaceId=\{workspaceId\}\s*sessionId=\{sessionId\}/
  );
  assert.doesNotMatch(source, /<Outlet \/>/);
});

test('workspace toolbar creation stays on the workspace route instead of pinning the old session route', () => {
  const source = readFile('src/components/layout/Toolbar.tsx');

  assert.match(
    source,
    /const targetWorkspaceId =\s*workspaceId \?\? activeWorktreeId \?\? rightSession\?\.workspaceId;/
  );
  assert.doesNotMatch(
    source,
    /paths\.projectSession\(\s*projectId,\s*rightSession\.workspaceId,\s*rightSession\.sessionId\s*\)\}\?newSession=1/
  );
});

test('right panel session creation switches the active workspace after new-workspace creation and keeps backend workspace creation intact', () => {
  const source = readFile('src/components/layout/RightPanelContent.tsx');
  const rustSource = readRepoFile('src-tauri/src/commands/sessions.rs');
  const localContainerSource = readRepoFile(
    'crates/local-deployment/src/container.rs'
  );

  assert.match(
    source,
    /const \{ activeWorktreeId, setActiveWorktree \} = useWorktree\(\)/
  );
  assert.match(source, /if \(createMode === 'new_workspace'\)/);
  assert.match(
    source,
    /setActiveWorktree\(newSession\.workspace_id,\s*newSession\.task_id \?\? null\)/
  );
  assert.match(rustSource, /pub async fn create_project_session/);
  assert.match(rustSource, /pub async fn ensure_project_workspace/);
  assert.match(rustSource, /find_matching_project_worktree_workspace/);
  assert.match(rustSource, /resolve_project_workspace/);
  assert.match(rustSource, /payload\.branch\.as_deref\(\)/);
  assert.match(rustSource, /ensure_container_exists\(&workspace\)/);
  assert.match(
    localContainerSource,
    /discover_workspace_dir_from_existing_worktree\(&repositories, &workspace\.branch\)/
  );
  assert.match(
    localContainerSource,
    /let workspace_root = Self::normalized_workspace_base_dir\(workspace, &repositories\);/
  );
});
