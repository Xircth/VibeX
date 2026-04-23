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

test('workspace path resolution is centralized for editor, terminal, and agent working directories', () => {
  const helperSource = readRepoFile('src-tauri/src/workspace_paths.rs');
  const workspacesSource = readRepoFile('src-tauri/src/commands/workspaces.rs');
  const sessionsSource = readRepoFile('src-tauri/src/commands/sessions.rs');
  const terminalSource = readRepoFile('src-tauri/src/commands/terminal.rs');

  assert.match(helperSource, /pub fn resolve_workspace_agent_working_dir/);
  assert.match(helperSource, /pub fn resolve_workspace_repo_root/);
  assert.match(helperSource, /pub fn resolve_workspace_default_open_path/);
  assert.match(helperSource, /return repo\.path\.clone\(\);/);
  assert.match(helperSource, /resolve_workspace_base_path/);
  assert.match(workspacesSource, /resolve_workspace_repo_root/);
  assert.match(workspacesSource, /resolve_workspace_default_open_path/);
  assert.match(
    sessionsSource,
    /resolve_workspace_agent_working_dir\(&workspace, &container_ref, &repos\)/
  );
  assert.match(
    terminalSource,
    /resolve_workspace_default_open_path\(&workspace, &container_ref, &repos\)/
  );
  assert.match(sessionsSource, /Workspace::update_container_ref/);
  assert.match(sessionsSource, /agent_working_dir = \?/);
});

test('workspace file tree resyncs when the resolved worktree root changes after repo data arrives', () => {
  const source = readFrontendFile(
    'src/components/panels/DockviewFileTreePanel.tsx'
  );
  const workspaceRootSource = readFrontendFile(
    'src/components/panels/workspaceRootPath.ts'
  );

  assert.match(source, /const resolvedWorkspaceRootPath = useMemo/);
  assert.match(
    source,
    /resolvedWorkspaceRootPath &&\s*\(\s*activeWorktreeId !== prevWorktreeIdRef\.current \|\|\s*resolvedWorkspaceRootPath !== rootPath\s*\)/
  );
  assert.match(source, /setSelectedFilePath\(null\)/);
  assert.match(source, /setDiffFilePath\(null\)/);
  assert.match(workspaceRootSource, /containerAlreadyPointsAtRepoRoot/);
});

test('task follow-up diff badge uses git status from the selected repo instead of diff-stream stats', () => {
  const source = readFrontendFile('src/components/tasks/TaskFollowUpSection.tsx');

  assert.match(source, /import \{ useGitStatus \} from '@\/hooks\/git';/);
  assert.match(source, /import \{ useWorktree \} from '@\/contexts\/WorktreeContext';/);
  assert.match(source, /import \{ useParams \} from 'react-router-dom';/);
  assert.match(
    source,
    /const workspaceId =\s*activeWorktreeId \?\?\s*routeWorkspaceId \?\?\s*workspaceIdProp \?\?\s*session\?\.workspace_id \?\?\s*null;/
  );
  assert.match(source, /const \{ repos, selectedRepoId \} = useAttemptRepo/);
  assert.match(source, /pollMode: 'background'/);
  assert.match(source, /const changedPaths = new Set<string>\(\)/);
  assert.doesNotMatch(source, /useDiffSummary/);
});
