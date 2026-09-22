import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

test('desktop Tauri dev uses the default cargo runner, not a CEF app bundle', () => {
  const desktopDev = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'run-tauri-dev-desktop.js'),
    'utf8'
  );

  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js')),
    false
  );
  assert.doesNotMatch(desktopDev, /run-tauri-dev-macos/);
  assert.doesNotMatch(desktopDev, /--runner/);
  assert.doesNotMatch(desktopDev, /cef-runtime|vibex_cef_helper/);
  assert.match(desktopDev, /exec',\s*'tauri',\s*'dev'/);
});
