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

test('workspace patches codex windows sandbox to avoid duplicate VERSION resources in installer builds', () => {
  const cargoToml = readRepoFile('Cargo.toml');

  assert.match(cargoToml, /\[patch\."https:\/\/github\.com\/openai\/codex\.git"\]/);
  assert.match(cargoToml, /codex-windows-sandbox\s*=\s*\{\s*path\s*=\s*"vendor\/codex-windows-sandbox-rs"/);
});
