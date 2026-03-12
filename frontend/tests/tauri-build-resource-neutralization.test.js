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

test('windows build script neutralizes codex sandbox resource with a valid cc-built static library', () => {
  const source = readRepoFile('src-tauri/build.rs');

  assert.match(source, /rustc-link-arg-bins=\/NODEFAULTLIB:resource\.lib/);
  assert.match(source, /cc::Build/);
  assert.match(source, /cargo_metadata\(false\)/);
  assert.match(source, /compile\("codex_windows_sandbox_empty_resource"\)/);
  assert.doesNotMatch(source, /let empty_archive = b"!<arch>\\n"/);
});
