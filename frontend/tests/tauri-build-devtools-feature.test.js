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

test('release tauri build leaves the devtools feature off', () => {
  const source = readRepoFile('src-tauri/Cargo.toml');

  assert.doesNotMatch(
    source,
    /tauri\s*=\s*\{[^}]*"devtools"/,
    'developer mode is a settings.json switch, not the compile-time tauri/devtools feature'
  );
});
