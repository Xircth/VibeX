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

test('terminal toolbar button uses panel-open state for its active appearance', () => {
  const toolbar = readFile('src/components/layout/Toolbar.tsx');
  const panelActions = readFile('src/hooks/usePanelActions.ts');

  assert.match(panelActions, /isPanelOpen/);
  assert.match(panelActions, /isTerminalOpen:\s*isPanelOpen\(PANEL_IDS\.TERMINAL\)/);
  assert.match(toolbar, /const isTerminalOpen = isPanelOpen\(PANEL_IDS\.TERMINAL\)/);
  assert.match(toolbar, /aria-pressed=\{isTerminalOpen\}/);
});
