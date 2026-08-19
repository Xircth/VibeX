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

test('streaming markdown renders the live value directly instead of deferring token output', () => {
  const source = readFile(
    'src/components/NormalizedConversation/AstryxMarkdown.tsx'
  );

  assert.doesNotMatch(source, /useDeferredValue/);
  assert.match(source, /value:/);
});
