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

test('system settings and config defaults use the vu worktree branch prefix', () => {
  const settingsSource = readFrontendFile(
    'src/pages/settings/SystemSettings.tsx'
  );
  const v7Source = readRepoFile(
    'crates/services/src/services/config/versions/v7.rs'
  );
  const v8Source = readRepoFile(
    'crates/services/src/services/config/versions/v8.rs'
  );
  const v9Source = readRepoFile(
    'crates/services/src/services/config/versions/v9.rs'
  );

  assert.match(settingsSource, /placeholder="vu"/);
  assert.match(v7Source, /"vu"\.to_string\(\)/);
  assert.match(v8Source, /"vu"\.to_string\(\)/);
  assert.match(v9Source, /"vu"\.to_string\(\)/);
});

test('workspace_dir override is runtime-updatable and applied on config save', () => {
  const worktreeManagerSource = readRepoFile(
    'crates/services/src/services/worktree_manager.rs'
  );
  const localDeploymentSource = readRepoFile(
    'crates/local-deployment/src/lib.rs'
  );
  const configCommandSource = readRepoFile('src-tauri/src/commands/config.rs');

  assert.match(
    worktreeManagerSource,
    /LazyLock<RwLock<Option<PathBuf>>>\s*=\s*LazyLock::new/
  );
  assert.match(
    worktreeManagerSource,
    /pub fn set_workspace_dir_override\(path: Option<PathBuf>\)/
  );
  assert.match(
    localDeploymentSource,
    /WorktreeManager::set_workspace_dir_override\(workspace_dir_override\)/
  );
  assert.match(
    configCommandSource,
    /WorktreeManager::set_workspace_dir_override\(workspace_dir_override\)/
  );
});

test('homepage git repo discovery scans broader roots with deeper search and longer timeouts', () => {
  const filesystemServiceSource = readRepoFile(
    'crates/services/src/services/filesystem.rs'
  );
  const filesystemCommandSource = readRepoFile(
    'src-tauri/src/commands/filesystem.rs'
  );

  assert.match(filesystemServiceSource, /fn push_unique_directory/);
  assert.match(filesystemServiceSource, /dirs::document_dir\(\)/);
  assert.match(filesystemServiceSource, /dirs::desktop_dir\(\)/);
  assert.match(filesystemServiceSource, /dirs::download_dir\(\)/);
  assert.match(filesystemServiceSource, /"projects"/);
  assert.match(filesystemServiceSource, /"source"/);
  assert.match(
    filesystemCommandSource,
    /list_git_repos\(Some\(p\.clone\(\)\), 2000, 5000, Some\(6\)\)/
  );
  assert.match(
    filesystemCommandSource,
    /list_common_git_repos\(2500, 6000, Some\(6\)\)/
  );
});

test('file tree clears stale project state and waits for repo data before syncing the new project root', () => {
  const source = readFrontendFile(
    'src/components/panels/DockviewFileTreePanel.tsx'
  );

  assert.match(source, /pendingProjectRootSyncRef/);
  assert.match(source, /setRootPath\(null\)/);
  assert.match(source, /setSelectedFilePath\(null\)/);
  assert.match(source, /setDiffFilePath\(null\)/);
  assert.match(source, /pendingProjectRootSyncRef\.current = projectId/);
  assert.match(
    source,
    /const workspaceBelongsToCurrentProject =\s*!projectId \|\| workspace\?\.project_id === projectId/
  );
  assert.match(
    source,
    /if \(pendingProjectRootSyncRef\.current !== projectId\)/
  );
  assert.match(source, /if \(!workspaceBelongsToCurrentProject\)/);
});
