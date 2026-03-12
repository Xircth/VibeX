import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('ProcessesTab 复用统一的 executor profile 提取工具', () => {
  const source = readFile('src/components/tasks/TaskDetails/ProcessesTab.tsx');

  assert.match(source, /extractProfileFromAction/);
  assert.doesNotMatch(source, /executor:\s*string/);
});
