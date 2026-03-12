import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('message box session selector renders a compact badge-like label', () => {
  const source = readFrontendFile('src/components/tasks/TaskFollowUpSection.tsx');

  assert.match(source, /import\s+\{\s*Badge\s*\}\s+from\s+'@\/components\/ui\/badge'/);
  assert.match(source, /function\s+truncateSessionLabel\s*\(/);
  assert.match(source, /truncateSessionLabel\(/);
  assert.match(source, /<Badge/);
  assert.match(source, /title=\{/);
});
