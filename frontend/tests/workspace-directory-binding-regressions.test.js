import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function readFile(relativePath) {
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
    .map(readFile)
    .join('\n');
}

test('终端目录跟随 workspace container_ref 和 agent_working_dir', () => {
  const source = readFile('src-tauri/src/commands/terminal.rs');

  assert.match(source, /ensure_container_exists\(&workspace\)/);
  assert.match(source, /workspace\s*\.\s*agent_working_dir/);
  assert.match(source, /base_dir\.join\(dir\)/);
  assert.match(source, /create_session\(working_dir,\s*cols,\s*rows,\s*shell,\s*session_id\)/);
});

test('workspace repo 列表返回当前 workspace 下的实际 repo 路径', () => {
  const source = readWorkspaceCommandSource();

  assert.match(source, /pub async fn get_workspace_repos/);
  assert.match(source, /ensure_container_exists\(&workspace\)/);
  assert.match(source, /workspace\.container_ref = Some\(container_ref\.clone\(\)\)/);
  assert.match(source, /repo\.repo\.path = workspace\s*\.\s*repo_path\(&repo\.repo\)/);
});
