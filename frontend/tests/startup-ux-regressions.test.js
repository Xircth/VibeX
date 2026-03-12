import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const frontendRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('app startup no longer shows release notes dialog on first entry', () => {
  const source = readFrontendFile('src/App.tsx');

  assert.doesNotMatch(source, /ReleaseNotesDialog\.show\(/);
  assert.match(source, /updateAndSaveConfig\(\{\s*show_release_notes:\s*false\s*\}\)/);
});

test('windows command spawns use hidden-console helpers for startup flows', () => {
  const processUtils = readRepoFile('crates/utils/src/process.rs');
  const envSource = readRepoFile('crates/executors/src/env.rs');
  const gitCli = readRepoFile('crates/git/src/cli.rs');
  const worktreeManager = readRepoFile('crates/services/src/services/worktree_manager.rs');
  const localDeployment = readRepoFile('crates/local-deployment/src/lib.rs');

  assert.match(processUtils, /configure_tokio_command_no_window/);
  assert.match(processUtils, /configure_std_command_no_window/);
  assert.match(envSource, /configure_tokio_command_no_window\(command\)/);
  assert.match(gitCli, /configure_std_command_no_window\(/);
  assert.match(worktreeManager, /configure_tokio_command_no_window\(/);
  assert.match(localDeployment, /configure_std_command_no_window\(/);
});
