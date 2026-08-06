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

test('workspace has no Codex sandbox linker workaround without the dependency', () => {
  const cargoLock = readRepoFile('Cargo.lock');
  const buildScript = readRepoFile('src-tauri/build.rs');

  assert.doesNotMatch(cargoLock, /name = "codex-windows-sandbox"/);
  assert.doesNotMatch(buildScript, /neutralize_codex_sandbox_resource/);
  assert.doesNotMatch(buildScript, /NODEFAULTLIB:resource\.lib/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'vendor/codex-windows-sandbox-rs')),
    false
  );
});
