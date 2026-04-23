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
  assert.doesNotMatch(source, /<Dialog/);
});

test('sonner theme classes cover default, success, and error toast variants', () => {
  const source = readFile('src/components/ui/sonner.tsx');

  assert.match(source, /title:/);
  assert.match(source, /success:/);
  assert.match(source, /error:/);
  assert.match(source, /group-\[\.toaster\]:bg-background\/98/);
  assert.match(source, /group-\[\.toaster\]:text-foreground/);
  assert.match(source, /group-\[\.toaster\]:border-border/);
});

test('app wires the toaster to the resolved theme instead of relying on sonner defaults', () => {
  const source = readFile('src/App.tsx');

  assert.match(source, /function ThemedToaster\(\)/);
  assert.match(source, /const \{ resolvedTheme \} = useTheme\(\)/);
  assert.match(source, /<Toaster theme=\{resolvedTheme\} \/>/);
});
