const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveSidecarBinDir } = require('./stage-host-sidecars');

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
