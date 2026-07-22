import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Web Preview has one CEF browser path and no iframe or proxy fallback', () => {
  const panel = readRepoFile(
    'frontend/src/components/panels/DockviewWebPreviewPanel.tsx'
  );
  const browser = readRepoFile(
    'frontend/src/features/browser/BrowserPanel.tsx'
  );

  assert.match(panel, /features\/browser\/BrowserPanel/);
  assert.match(browser, /browserApi\.createTab/);
  assert.doesNotMatch(panel, /<iframe|previewBridge|getPreviewProxyUrl/);
  assert.doesNotMatch(browser, /<iframe|previewBridge|getPreviewProxyUrl/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src-tauri/src/preview_proxy.rs')),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, 'frontend/src/utils/installWebCompanion.ts')
    ),
    false
  );
});

test('Tauri registers the owned browser commands and every desktop bundle overlay', () => {
  const tauri = readRepoFile('src-tauri/src/lib.rs');
  const workspace = readRepoFile('Cargo.toml');

  assert.match(workspace, /"crates\/browser-cef"/);
  assert.match(tauri, /commands::browser::browser_create_tab/);
  assert.match(tauri, /commands::browser::browser_apply_intent/);
  assert.match(tauri, /commands::browser::browser_close_tab/);
  assert.doesNotMatch(tauri, /preview_proxy/);

  for (const platform of ['macos', 'linux', 'windows']) {
    assert.equal(
      fs.existsSync(
        path.join(repoRoot, `src-tauri/tauri.${platform}.conf.json`)
      ),
      true
    );
  }
});
