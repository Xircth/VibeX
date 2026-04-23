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

test('workspace route without a current session reuses the conversation view instead of injecting a stale latest session', () => {
  const source = readFile('src/pages/ProjectTasks.tsx');

  assert.match(source, /sessionId=\{routeSessionId\}/);
  assert.match(
    source,
    /const matchedInitialSession =\s*routeSessionId && attempt\.session\?\.id === routeSessionId/
  );
  assert.match(source, /<KanbanSessionConversationView/);
  assert.match(source, /interactive=\{true\}/);
  assert.match(source, /showSessionSelector=\{true\}/);
  assert.doesNotMatch(
    source,
    /const effectiveSessionId = sessionId \?\? attempt\.session\?\.id/
  );
});
