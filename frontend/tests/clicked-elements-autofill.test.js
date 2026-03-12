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

test('clicked element markdown is auto-inserted into follow-up editor and cleared from pending selections', () => {
  const source = readFrontendFile('src/components/tasks/TaskFollowUpSection.tsx');

  assert.match(source, /const\s+lastAutoInsertedClickedMarkdownRef\s*=\s*useRef\(''\)/);
  assert.match(source, /if\s*\(!clickedMarkdown\)\s*\{/);
  assert.match(source, /clearClickedElements\(\)/);
  assert.match(source, /setLocalMessage\(/);
  assert.match(source, /setFollowUpMessageRef\.current\(newMessage\)/);
});
