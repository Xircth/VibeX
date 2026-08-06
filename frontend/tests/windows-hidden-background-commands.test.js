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

test('background skill installation uses the shared no-window command path', () => {
  const source = readRepoFile('crates/agents/src/skills.rs');
  const start = source.indexOf('async fn run_skills_add');
  const end = source.indexOf('\n}\n', start);
  const implementation = source.slice(start, end);

  assert.notEqual(start, -1, 'run_skills_add must exist');
  assert.match(implementation, /new_hidden_tokio_command/);
  assert.doesNotMatch(implementation, /Command::new\(["']cmd(?:\.exe)?["']\)/);
});
