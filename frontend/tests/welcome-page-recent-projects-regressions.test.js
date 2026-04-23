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

test('welcome page recent projects use context-menu actions plus shared confirm dialog for delete', () => {
  const source = readFile('src/components/welcome/WelcomePage.tsx');

  assert.match(source, /title="左键打开项目，右键显示打开和删除操作"/);
  assert.match(source, /ConfirmDialog\.show\(\{/);
  assert.match(source, /variant: 'destructive'/);
  assert.match(source, /projectsApi\.delete\(targetProject\.id\)/);
  assert.match(source, /toast\.success\(/);
  assert.match(source, /toast\.error\(/);
  assert.doesNotMatch(source, /toast\.warning\(/);
});
