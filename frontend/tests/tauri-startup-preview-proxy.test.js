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

test('preview proxy uses axum 0.8 wildcard route syntax', () => {
  const source = readRepoFile('src-tauri/src/preview_proxy.rs');

  assert.match(source, /route\("\/\{\*path\}"/);
  assert.doesNotMatch(source, /route\("\/\*path"/);
});

test('preview proxy does not route local dev server traffic through system proxy', () => {
  const source = readRepoFile('src-tauri/src/preview_proxy.rs');

  assert.match(
    source,
    /Client::builder\(\)[\s\S]*\.no_proxy\(\)[\s\S]*\.build\(\)/
  );
});

test('preview proxy streams non-html responses instead of buffering all assets', () => {
  const source = readRepoFile('src-tauri/src/preview_proxy.rs');

  assert.match(source, /Body::from_stream\(/);
  assert.match(source, /\.bytes_stream\(\)/);
  assert.match(source, /if !is_html \{/);
});

test('preview proxy uses a short local connect timeout before retrying host variants', () => {
  const source = readRepoFile('src-tauri/src/preview_proxy.rs');

  assert.match(source, /\.connect_timeout\(Duration::from_millis\(250\)\)/);
  assert.match(source, /build_upstream_url_candidates/);
  assert.match(source, /remember_successful_upstream_host/);
});

test('tauri setup manages AppState before async background tasks start', () => {
  const source = readRepoFile('src-tauri/src/lib.rs');

  assert.match(
    source,
    /let state = tauri::async_runtime::block_on\(AppState::new\(\)\)/
  );
  assert.match(source, /app\.manage\(state\);/);
  assert.doesNotMatch(
    source,
    /tauri::async_runtime::spawn\(async move \{[\s\S]*handle\.manage\(state\);[\s\S]*\}\);/
  );
});
