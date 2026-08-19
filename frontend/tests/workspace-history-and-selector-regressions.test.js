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

test('settings header no longer shows the VibeX desktop wording', () => {
  const source = readFile('src/pages/settings/SettingsLayout.tsx');

  assert.doesNotMatch(source, /VibeX 桌面端设置/);
});

test('branding tagline stays on the multi-task Vibe Coding copy', () => {
  const source = readFile('src/lib/branding.ts');

  assert.match(source, /APP_TAGLINE\s*=\s*['"]高效多并发驱动的Vibe Coding['"]/);
});

test('loading history view uses the current scroll container instead of the old timeout overlay', () => {
  const source = readFile('src/components/logs/VirtualizedList.tsx');

  assert.match(source, /data-panel="conversation-logs"/);
  assert.match(source, /className="h-full overflow-y-auto px-2 py-3"/);
  assert.match(source, /findPreviousUserMessageKey/);
  assert.doesNotMatch(
    source,
    /setTimeout\(\s*\(\)\s*=>\s*\{\s*setLoading\(false\);/
  );
});

test('worktree selector stays controlled while supporting branch-based project workspace switching', () => {
  const source = readFile('src/components/layout/WorktreeSelector.tsx');

  assert.match(source, /const\s*\[open,\s*setOpen\]\s*=\s*useState\(false\)/);
  assert.match(
    source,
    /<DropdownMenu\s+open=\{open\}\s+onOpenChange=\{setOpen\}>/
  );
  assert.match(source, /buildWorkspaceBranchOptions/);
  assert.match(source, /sessionsApi\.ensureProjectWorkspace/);
  assert.match(
    source,
    /if\s*\(\s*option\.useWorktree\s*&&\s*option\.directWorkspaceId\s*\)/
  );
  assert.match(source, /setOpen\(false\);/);
});
