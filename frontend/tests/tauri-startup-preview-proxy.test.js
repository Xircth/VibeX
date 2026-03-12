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

test('preview proxy uses axum 0.8 wildcard route syntax', () => {
  const source = readRepoFile('src-tauri/src/preview_proxy.rs');

  assert.match(source, /route\("\/\{\*path\}"/);
  assert.doesNotMatch(source, /route\("\/\*path"/);
});

test('tauri setup manages AppState before async background tasks start', () => {
  const source = readRepoFile('src-tauri/src/lib.rs');

  assert.match(source, /let state = tauri::async_runtime::block_on\(AppState::new\(\)\)/);
  assert.match(source, /app\.manage\(state\);/);
  assert.doesNotMatch(
    source,
    /tauri::async_runtime::spawn\(async move \{[\s\S]*handle\.manage\(state\);[\s\S]*\}\);/
  );
});
