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

test('welcome page recent projects use a context menu and shared centered confirm dialog instead of a nested local dialog shell', () => {
  const source = readFile('src/components/welcome/WelcomePage.tsx');

  assert.match(source, /onContextMenu=\{onContextMenu\}/);
  assert.match(source, /setContextMenu\(/);
  assert.match(source, /handleOpenFromContextMenu/);
  assert.match(source, /handleDeleteFromContextMenu/);
  assert.match(source, /ConfirmDialog\.show\(\{/);
  assert.match(source, /toast\.success\(/);
  assert.match(source, /PROJECT_DELETE_TOAST_OPTIONS/);
  assert.doesNotMatch(source, /<Dialog/);
});

test('sonner theme classes cover default, success, and error toast variants', () => {
  const source = readFile('src/components/ui/sonner.tsx');
  const cssSource = readFile('src/styles/legacy/index.css');

  assert.match(source, /title:/);
  assert.match(source, /success:/);
  assert.match(source, /error:/);
  assert.match(source, /position="top-right"/);
  assert.match(source, /vu-sonner-toast/);
  assert.match(source, /vu-sonner-toast-success/);
  assert.match(source, /vu-sonner-toast-error/);
  assert.match(cssSource, /backdrop-filter:\s*blur\(24px\) saturate\(1\.55\)/);
  assert.match(cssSource, /oklch\(1 0 0 \/ 0\.76\)/);
  assert.match(cssSource, /border-radius:\s*18px !important/);
  assert.match(cssSource, /--width:\s*356px !important/);
});

test('app wires the toaster to the resolved theme instead of relying on sonner defaults', () => {
  const source = readFile('src/App.tsx');

  assert.match(source, /function ThemedToaster\(\)/);
  assert.match(source, /const \{ resolvedTheme \} = useTheme\(\)/);
  assert.match(source, /<Toaster theme=\{resolvedTheme\} \/>/);
});
