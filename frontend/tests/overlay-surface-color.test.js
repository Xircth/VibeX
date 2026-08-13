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

test('浅色弹窗、浮层与通知共用 #FAFAFA 表面', () => {
  const appStyles = readFile('src/styles/legacy/index.css');
  const toastStyles = readFile('src/components/ui/toast.css');

  assert.match(
    appStyles,
    /\.legacy-design\s*\{[\s\S]*?--surface-popover:\s*#fafafa;/
  );
  assert.match(
    appStyles,
    /\.dialog-surface\s*\{[\s\S]*?background:\s*var\(--surface-popover\);/
  );
  assert.match(
    appStyles,
    /\.tahoe-popover\s*\{[\s\S]*?background:\s*var\(--surface-popover\);/
  );
  assert.match(
    toastStyles,
    /\.vu-toast-surface\s*\{[\s\S]*?background:\s*var\(--surface-popover,/
  );
});
