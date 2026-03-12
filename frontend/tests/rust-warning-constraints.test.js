import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('workspaces 命令不导入未使用的 CommitGraph', () => {
  const source = readRepoFile('src-tauri/src/commands/workspaces.rs');

  assert.doesNotMatch(
    source,
    /use git::\{CommitGraph, ConflictOp, GitCliError, GitRemote, GitService, GitServiceError\};/
  );
});
