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
  const source = readFile('src/components/NormalizedConversation/Markdown.tsx');

  assert.doesNotMatch(source, /useDeferredValue/);
  assert.match(source, /\{value\}/);
});

test('conversation history avoids long empty-stream waits before showing the next turn', () => {
  const source = readFile(
    'src/hooks/useConversationHistory/useConversationHistory.ts'
  );

  assert.match(source, /HISTORIC_STREAM_IDLE_TIMEOUT_MS = 200/);
  assert.match(source, /HISTORIC_STREAM_MAX_WAIT_MS = 8000/);
  assert.match(source, /EMPTY_RUNNING_STREAM_RETRY_MS = 100/);
  assert.match(source, /MAX_EMPTY_RUNNING_STREAM_RETRIES = 3/);
  assert.match(source, /\}, 400\);/);
});
