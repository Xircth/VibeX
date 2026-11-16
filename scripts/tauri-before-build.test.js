const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertFrontendDistReady,
  shouldSkipFrontendBuild,
} = require('./tauri-before-build');

test('frontend build is skipped only when DIMO_SKIP_FRONTEND_BUILD=1', () => {
  assert.equal(shouldSkipFrontendBuild({}), false);
  assert.equal(shouldSkipFrontendBuild({ DIMO_SKIP_FRONTEND_BUILD: '' }), false);
  assert.equal(shouldSkipFrontendBuild({ DIMO_SKIP_FRONTEND_BUILD: '1' }), true);
});

test('skipped frontend build requires a prepared dist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-frontend-dist-'));
  const dist = path.join(root, 'frontend', 'dist');

  try {
    assert.throws(() => assertFrontendDistReady(root), /frontend\/dist\/index\.html/);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    assert.doesNotThrow(() => assertFrontendDistReady(root));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
