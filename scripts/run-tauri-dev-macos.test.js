const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isStagedBundleReady,
  resolveDevSigningIdentity,
} = require('./run-tauri-dev-macos');

test('macOS CEF dev signing uses Developer ID when APPLE_SIGNING_IDENTITY is set', () => {
  assert.equal(resolveDevSigningIdentity({}), '-');
  assert.equal(resolveDevSigningIdentity({ APPLE_SIGNING_IDENTITY: '  ' }), '-');
  assert.equal(
    resolveDevSigningIdentity({
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Xing Mei (4V898ZZZ3G)',
    }),
    'Developer ID Application: Xing Mei (4V898ZZZ3G)'
  );
});

function writeStagedBundleFixture(bundleIdentifier) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-cef-identity-'));
  const frameworkResources = path.join(fixture, 'framework-resources');
  const helperExecutable = path.join(fixture, 'helper');
  const manifest = path.join(fixture, 'cef-runtime-manifest.json');
  fs.mkdirSync(frameworkResources);
  fs.writeFileSync(path.join(frameworkResources, 'icudtl.dat'), 'icu');
  fs.writeFileSync(helperExecutable, 'helper');
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      bundleIdentifier,
    })}\n`
  );
  return {
    fixture,
    paths: {
      frameworkResources,
      helperExecutables: [{ destination: helperExecutable }],
      manifest,
    },
  };
}

test('macOS CEF dev cache is ready only for the VibeX Dev bundle identity', () => {
  const product = writeStagedBundleFixture('com.vibex.app');
  const missing = writeStagedBundleFixture(undefined);
  const dev = writeStagedBundleFixture('com.vibex.app.dev');

  try {
    assert.equal(isStagedBundleReady(product.paths), false);
    assert.equal(isStagedBundleReady(missing.paths), false);
    assert.equal(isStagedBundleReady(dev.paths), true);
  } finally {
    fs.rmSync(product.fixture, { force: true, recursive: true });
    fs.rmSync(missing.fixture, { force: true, recursive: true });
    fs.rmSync(dev.fixture, { force: true, recursive: true });
  }
});

test('macOS CEF dev staging requests the isolated development bundle identity', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, 'run-tauri-dev-macos.js'),
    'utf8'
  );
  const stager = fs.readFileSync(
    path.join(__dirname, 'stage-cef-runtime.js'),
    'utf8'
  );

  assert.match(runner, /--dev-bundle/);
  assert.match(runner, /com\.vibex\.app\.dev/);
  assert.doesNotMatch(stager, /--dev-bundle/);
});
