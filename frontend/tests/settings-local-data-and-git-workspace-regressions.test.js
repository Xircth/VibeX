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

test('system settings exposes local data clear action and calls the config api', () => {
  const source = readFrontendFile('src/pages/settings/SystemSettings.tsx');
  const apiSource = readFrontendFile('src/lib/api/config.ts');

  assert.match(source, /CLEAR_LOCAL_DATA_TITLE/);
  assert.match(source, /handleClearLocalData/);
  assert.match(source, /confirmClearLocalData/);
  assert.match(source, /configApi\.clearLocalData\(\)/);
  assert.match(
    source,
    /useWindowProjectsStore\.getState\(\)\.resetProjectWindowState\(\)/
  );
  assert.match(source, /toast\.warning/);
  assert.match(source, /toast\.loading/);
  assert.match(source, /toast\.dismiss/);
  assert.match(
    source,
    /!window\.location\.pathname\.startsWith\('\/settings'\)/
  );
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(
    apiSource,
    /clearLocalData: async \(\): Promise<ClearLocalDataResponse>/
  );
  assert.match(apiSource, /clear_local_app_data/);
});

test('settings routes do not run main-window onboarding after local data reset', () => {
  const source = readFrontendFile('src/App.tsx');

  assert.match(source, /const location = useLocation\(\)/);
  assert.match(source, /location\.pathname\.startsWith\('\/settings'\)/);
});

test('tauri clear_local_app_data resets config, clears runtime caches, and preserves worktree dirs', () => {
  const source = readRepoFile('src-tauri/src/commands/config.rs');
  const libSource = readRepoFile('src-tauri/src/lib.rs');

  assert.match(source, /pub async fn clear_local_app_data/);
  assert.match(source, /ExecutionProcess::find_running/);
  assert.match(source, /kill_all_running_processes/);
  assert.match(source, /still_running/);
  assert.match(source, /let statement = format!\(/);
  assert.match(source, /DELETE FROM/);
  assert.match(source, /Config::default\(\)/);
  assert.match(source, /WorktreeManager::set_workspace_dir_override\(None\)/);
  assert.match(source, /ExecutorConfigs::reload\(\)/);
  assert.match(source, /state\.file_tree_watchers\.lock\(\)\.await\.clear\(\)/);
  assert.match(libSource, /commands::config::clear_local_app_data/);
});

test('repo registration and worktree cleanup protect user project directories', () => {
  const repoSource = readRepoFile('crates/services/src/services/repo.rs');
  const worktreeSource = readRepoFile(
    'crates/services/src/services/worktree_manager.rs'
  );
  const workspaceSource = readRepoFile(
    'crates/services/src/services/workspace_manager.rs'
  );
  const containerSource = readRepoFile(
    'crates/local-deployment/src/container.rs'
  );

  assert.match(repoSource, /path\.join\("\.git"\)\.exists\(\)/);
  assert.match(repoSource, /canonical_workdir != normalized_path/);
  assert.match(
    repoSource,
    /child_directory_inside_parent_repo_is_not_registered_as_parent_repo/
  );
  assert.match(worktreeSource, /validate_worktree_target/);
  assert.match(worktreeSource, /Refusing to use repository path/);
  assert.match(worktreeSource, /ensure_worktree_refuses_to_target_source_repo/);
  assert.match(workspaceSource, /is_app_owned_workspace_dir/);
  assert.match(workspaceSource, /overlaps_known_repo/);
  assert.match(workspaceSource, /UnsafeWorkspacePath/);
  assert.match(workspaceSource, /validate_workspace_container_path/);
  assert.match(
    workspaceSource,
    /ensure_workspace_refuses_user_project_directory_as_container/
  );
  assert.match(workspaceSource, /Refusing to clean workspace path/);
  assert.match(containerSource, /Refusing to remove workspace directory/);
  assert.match(containerSource, /repair_workspace_storage_mode/);
  assert.match(containerSource, /Workspace::update_storage_mode/);
  assert.match(containerSource, /Workspace::clear_container_ref/);
  assert.match(containerSource, /overlapping repo/);
  assert.match(containerSource, /is_direct_external_worktree/);
  assert.match(
    containerSource,
    /WorkspaceManager::is_app_owned_workspace_dir\(workspace_root\)/
  );
  assert.match(containerSource, /External worktree path does not exist/);
  const workspaceCommandSource = readRepoFile(
    'src-tauri/src/commands/workspaces.rs'
  );
  assert.match(workspaceCommandSource, /recover_workspace_container_ref/);
  assert.match(workspaceCommandSource, /path_overlaps_repo/);
  assert.match(workspaceCommandSource, /Workspace::update_storage_mode/);
  assert.match(
    workspaceCommandSource,
    /imported_single_repo_agent_working_dir/
  );
  const sessionCommandSource = readRepoFile(
    'src-tauri/src/commands/sessions.rs'
  );
  assert.match(sessionCommandSource, /workspace_container_overlaps_repo/);
  assert.match(
    sessionCommandSource,
    /find_matching_project_worktree_workspace/
  );
  assert.match(sessionCommandSource, /ensure_project_root_workspace/);
});

test('git hooks and panels key their data by workspace id so git state follows the active workspace', () => {
  const statusSource = readFrontendFile('src/hooks/git/useGitStatus.ts');
  const diffsSource = readFrontendFile('src/hooks/git/useGitDiffs.ts');
  const logSource = readFrontendFile('src/hooks/git/useGitLog.ts');
  const rebaseSource = readFrontendFile('src/hooks/useRebase.ts');
  const mergeSource = readFrontendFile('src/hooks/useMerge.ts');
  const changeTargetSource = readFrontendFile(
    'src/hooks/useChangeTargetBranch.ts'
  );

  assert.match(statusSource, /\['gitStatus', workspaceId, repoId\]/);
  assert.match(
    statusSource,
    /workspaceId\s*\?\s*await attemptsApi\.getGitStatus/
  );
  assert.match(diffsSource, /\['gitDiffs', workspaceId, repoId\]/);
  assert.match(
    diffsSource,
    /workspaceId\s*\?\s*await attemptsApi\.getFileDiffs/
  );
  assert.match(logSource, /\['gitLog', workspaceId, repoId\]/);
  assert.match(logSource, /workspaceId\s*\?\s*await attemptsApi\.getGitLog/);
  assert.match(rebaseSource, /queryKey: \['branchStatus', attemptId\]/);
  assert.match(rebaseSource, /queryKey: \['attemptRepo', attemptId\]/);
  assert.match(mergeSource, /queryKey: \['branchStatus', attemptId\]/);
  assert.match(mergeSource, /queryKey: \['gitDiffs', attemptId\]/);
  assert.match(mergeSource, /queryKey: \['gitLog', attemptId\]/);
  assert.match(changeTargetSource, /queryKey: \['attemptRepo', attemptId\]/);
});

test('git settings flow into workspace creation and worktree storage at runtime', () => {
  const configCommandSource = readRepoFile('src-tauri/src/commands/config.rs');
  const deploymentSource = readRepoFile('crates/local-deployment/src/lib.rs');
  const containerSource = readRepoFile(
    'crates/local-deployment/src/container.rs'
  );
  const serviceContainerSource = readRepoFile(
    'crates/services/src/services/container.rs'
  );
  const taskCommandSource = readRepoFile('src-tauri/src/commands/tasks.rs');
  const sessionCommandSource = readRepoFile(
    'src-tauri/src/commands/sessions.rs'
  );
  const workspaceCommandSource = readRepoFile(
    'src-tauri/src/commands/workspaces.rs'
  );

  assert.match(
    configCommandSource,
    /is_valid_branch_prefix\(&new_config\.git_branch_prefix\)/
  );
  assert.match(
    configCommandSource,
    /WorktreeManager::set_workspace_dir_override\(workspace_dir_override\)/
  );
  assert.match(deploymentSource, /raw_config\s*\.workspace_dir\s*\.as_ref\(\)/);
  assert.match(
    deploymentSource,
    /WorktreeManager::set_workspace_dir_override\(workspace_dir_override\)/
  );
  assert.match(
    containerSource,
    /self\.config\.read\(\)\.await\.git_branch_prefix\.clone\(\)/
  );
  assert.match(serviceContainerSource, /async fn git_branch_from_workspace/);
  assert.match(
    serviceContainerSource,
    /let prefix = self\.git_branch_prefix\(\)\.await/
  );
  assert.match(
    taskCommandSource,
    /git_branch_from_workspace\(&attempt_id, &task\.title\)/
  );
  assert.match(
    sessionCommandSource,
    /git_branch_from_workspace\(&workspace_id, &workspace_title\)/
  );
  assert.match(
    workspaceCommandSource,
    /git_branch_from_workspace\(&attempt_id, &task\.title\)/
  );
});
