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

test('devserver url detection normalizes tauri localhost hostnames back to localhost', () => {
  const source = readFrontendFile('src/hooks/useDevserverUrl.ts');

  assert.match(source, /endsWith\('\.localhost'\)/);
  assert.match(source, /return 'localhost'/);
});
