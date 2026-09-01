const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveSidecarBinDir,
  sidecarBinsExist,
} = require('./stage-host-sidecars');

test('sidecar binaries are read from the cargo target triple directory', () => {
  const resolved = resolveSidecarBinDir({
    repo: '/repo',
    env: {
      TAURI_ENV_TARGET_TRIPLE: 'x86_64-unknown-linux-gnu',
    },
    hostTriple: 'aarch64-unknown-linux-gnu',
  });

  assert.equal(resolved.triple, 'x86_64-unknown-linux-gnu');
  assert.equal(resolved.profile, 'release');
  assert.equal(
    resolved.binDir,
    path.join('/repo/target', 'x86_64-unknown-linux-gnu', 'release')
  );
});

test('sidecar layout prefers VIBEX_BUILD_TARGET and the active cargo profile', () => {
  const resolved = resolveSidecarBinDir({
    repo: '/repo',
    env: {
      CARGO_TARGET_DIR: '/custom-target',
      CARGO_PROFILE: 'debug',
      TAURI_ENV_TARGET_TRIPLE: 'ignored-triple',
      VIBEX_BUILD_TARGET: 'aarch64-pc-windows-msvc',
    },
    hostTriple: 'x86_64-pc-windows-msvc',
  });

  assert.equal(resolved.triple, 'aarch64-pc-windows-msvc');
  assert.equal(resolved.profile, 'debug');
  assert.equal(
    resolved.binDir,
    path.join('/custom-target', 'aarch64-pc-windows-msvc', 'debug')
  );
});

test('sidecar rebuild is skipped only when both Host binaries exist', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-sidecars-'));
  const env = {
    CARGO_TARGET_DIR: path.join(repo, 'target'),
    VIBEX_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
    CARGO_PROFILE: 'release',
  };
  const binDir = path.join(
    env.CARGO_TARGET_DIR,
    'x86_64-unknown-linux-gnu',
    'release'
  );
  fs.mkdirSync(binDir, { recursive: true });

  assert.equal(
    sidecarBinsExist({
      repo,
      env,
      hostTriple: 'x86_64-unknown-linux-gnu',
      platform: 'linux',
    }),
    false
  );

  fs.writeFileSync(path.join(binDir, 'vibex-mcp'), '');
  fs.writeFileSync(path.join(binDir, 'vibex-workflow-mcp'), '');
  assert.equal(
    sidecarBinsExist({
      repo,
      env,
      hostTriple: 'x86_64-unknown-linux-gnu',
      platform: 'linux',
    }),
    true
  );
});
