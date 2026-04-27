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

test('editor settings and config defaults use the vu worktree branch prefix', () => {
  const settingsSource = readFrontendFile(
    'src/pages/settings/EditorSettings.tsx'
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

test('homepage git repo discovery scans the user root and only accepts openable git repositories', () => {
  const filesystemServiceSource = readRepoFile(
    'crates/services/src/services/filesystem.rs'
  );
  const filesystemCommandSource = readRepoFile(
    'src-tauri/src/commands/filesystem.rs'
  );

  assert.match(
    filesystemServiceSource,
    /unwrap_or_else\(Self::get_home_directory\)/
  );
  assert.match(
    filesystemServiceSource,
    /Self::verify_directory\(&base_path\)\?/
  );
  assert.match(filesystemServiceSource, /vec!\[base_path\]/);
  assert.match(
    filesystemCommandSource,
    /list_git_repos\(Some\(p\.clone\(\)\), 2000, 5000, Some\(6\)\)/
  );
  assert.match(
    filesystemCommandSource,
    /list_git_repos\(None, 6000, 12000, Some\(8\)\)/
  );
  assert.doesNotMatch(
    filesystemCommandSource,
    /list_common_git_repos\(2500, 6000, Some\(6\)\)/
  );
  assert.match(filesystemServiceSource, /git2::Repository::open\(path\)/);
  assert.match(filesystemServiceSource, /repo\.workdir\(\)\?/);

  const repoServiceSource = readRepoFile(
    'crates/services/src/services/repo.rs'
  );
  assert.match(repoServiceSource, /pub fn resolve_git_repo_path/);
  assert.match(
    repoServiceSource,
    /RepoModel::find_or_create\(pool, &repo_path, display_name\)/
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

test('file tree treats Windows extended-length paths as absolute paths', () => {
  const dockviewSource = readFrontendFile(
    'src/components/panels/DockviewFileTreePanel.tsx'
  );
  const fileTreeSource = readFrontendFile(
    'src/components/file-tree/FileTreePanel.tsx'
  );

  assert.match(dockviewSource, /normalizedPath\.startsWith\('\\\\\\\\'\)/);
  assert.match(fileTreeSource, /normalizedPath\.startsWith\('\\\\\\\\'\)/);
  assert.match(dockviewSource, /stripWindowsExtendedPathPrefix/);
  assert.match(fileTreeSource, /stripWindowsExtendedPathPrefix/);
  assert.match(fileTreeSource, /\^\[\\\\\/\]\\\?\[\\\\\/\]\[a-zA-Z\]:/);
  assert.match(fileTreeSource, /if \(isAbsolutePath\(normalizedPath\)\) \{/);
  assert.match(fileTreeSource, /return normalizedPath;/);
});

test('file tree exposes a manual refresh button and routes it through the full refresh token path', () => {
  const panelSource = readFrontendFile(
    'src/components/panels/DockviewFileTreePanel.tsx'
  );
  const fileTreeSource = readFrontendFile(
    'src/components/file-tree/FileTreePanel.tsx'
  );

  assert.match(
    panelSource,
    /const refreshFileTree = useCallback\(async \(\) => \{/
  );
  assert.match(panelSource, /await loadRootChildren\(\);/);
  assert.match(panelSource, /setRefreshToken\(\(value\) => value \+ 1\)/);
  assert.match(panelSource, /void refreshFileTree\(\);/);
  assert.match(panelSource, /onRefreshFiles=\{refreshFileTree\}/);

  assert.match(fileTreeSource, /RefreshCw/);
  assert.match(fileTreeSource, /aria-label="刷新文件树"/);
  assert.match(fileTreeSource, /title="刷新文件树"/);
  assert.match(fileTreeSource, /onClick=\{\(\) => onRefreshFiles\?\.\(\)\}/);
});
