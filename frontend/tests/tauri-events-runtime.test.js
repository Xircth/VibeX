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

test('events forwarding uses tauri async runtime instead of raw tokio spawn', () => {
  const source = readRepoFile('src-tauri/src/events.rs');

  assert.match(source, /tauri::async_runtime::spawn/);
  assert.doesNotMatch(source, /tokio::spawn/);
});
