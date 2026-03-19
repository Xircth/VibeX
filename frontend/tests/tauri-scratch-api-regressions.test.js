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

test('tauri scratch api is wired instead of throwing placeholders', () => {
  const miscApi = readFrontendFile('src/lib/api/misc.ts');

  assert.match(miscApi, /tauriInvoke<Scratch>\('create_scratch'/);
  assert.match(miscApi, /tauriInvoke<Scratch>\('get_scratch'/);
  assert.match(miscApi, /tauriInvoke<void>\('update_scratch'/);
  assert.match(miscApi, /tauriInvoke<void>\('delete_scratch'/);
  assert.doesNotMatch(miscApi, /Scratch API not yet implemented for Tauri/);
});

test('tauri backend exposes scratch CRUD commands', () => {
  const scratchCommands = readRepoFile('src-tauri/src/commands/scratch.rs');
  const libSource = readRepoFile('src-tauri/src/lib.rs');
  const modSource = readRepoFile('src-tauri/src/commands/mod.rs');

  assert.match(modSource, /pub mod scratch;/);
  assert.match(scratchCommands, /pub async fn create_scratch/);
  assert.match(scratchCommands, /pub async fn get_scratch/);
  assert.match(scratchCommands, /pub async fn update_scratch/);
  assert.match(scratchCommands, /pub async fn delete_scratch/);
  assert.match(libSource, /commands::scratch::create_scratch/);
  assert.match(libSource, /commands::scratch::get_scratch/);
  assert.match(libSource, /commands::scratch::update_scratch/);
  assert.match(libSource, /commands::scratch::delete_scratch/);
});
