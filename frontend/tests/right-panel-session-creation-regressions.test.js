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

test('右侧执行区新建会话不再借道左侧 createSession 路由参数', () => {
  const source = readFile('src/components/layout/RightPanelContent.tsx');

  assert.doesNotMatch(source, /\?createSession=1/);
  assert.doesNotMatch(source, /navigate\(/);
});

test('右侧执行区直接使用本地会话创建表单并在成功后落到右侧', () => {
  const source = readFile('src/components/layout/RightPanelContent.tsx');

  assert.doesNotMatch(source, /<Popover/);
  assert.match(source, /<SessionCreationForm/);
  assert.match(source, /sessionsApi\.createProject/);
  assert.match(source, /placeCreatedSession\(/);
  assert.match(
    source,
    /absolute inset-0 z-10 flex items-center justify-center/
  );
  assert.match(
    source,
    /onClick=\{\(\) => handleCreateOverlayOpenChange\(true\)\}/
  );
  assert.match(
    source,
    /onCancel=\{\(\) => handleCreateOverlayOpenChange\(false\)\}/
  );
  assert.match(source, /useTaskAttempt\(fallbackWorkspaceId\)/);
  assert.match(
    source,
    /useTaskAttempt\(\s*lastActiveWorkspaceId \?\? undefined\s*\)/
  );
  assert.match(source, /workspaceBranchOptions/);
  assert.match(source, /selectedWorkspaceOption\?\.useWorktree/);
  assert.match(source, /branch:\s*createMode === 'existing_workspace'/);
  assert.match(source, /useRepoBranches\(primaryRepo\?\.id/);
  assert.match(source, /if \(!isCreateOverlayOpen \|\| isLoadingWorktrees\)/);
});

test('右侧执行区在新工作区创建成功后会切换主工作区，并确保后端目录已创建', () => {
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
  assert.match(rustSource, /payload\.branch\.as_deref\(\)/);
  assert.match(rustSource, /ensure_container_exists\(&workspace\)/);
  assert.match(
    localContainerSource,
    /discover_workspace_dir_from_existing_worktree\(&repositories, &workspace\.branch\)/
  );
  assert.match(
    localContainerSource,
    /return self\.create\(workspace\)\.await;/
  );
});
