const assert = require('node:assert/strict');
const test = require('node:test');

const { sidecarBuildArgs } = require('./tauri-before-bundle');

test('sidecar cargo build uses the same release target as the desktop binary', () => {
  const args = sidecarBuildArgs({
    debug: false,
    target: 'x86_64-apple-darwin',
  });

  assert.equal(args[0], 'build');
  assert.ok(args.includes('vibex-mcp'));
  assert.ok(args.includes('vibex-workflow-mcp'));
  assert.ok(args.includes('--release'));
  assert.deepEqual(
    args.slice(args.indexOf('--target'), args.indexOf('--target') + 2),
    ['--target', 'x86_64-apple-darwin']
  );
});

test('debug sidecar cargo build omits --release', () => {
  const args = sidecarBuildArgs({
    debug: true,
    target: 'aarch64-unknown-linux-gnu',
  });

  assert.equal(args.includes('--release'), false);
  assert.deepEqual(
    args.slice(args.indexOf('--target'), args.indexOf('--target') + 2),
    ['--target', 'aarch64-unknown-linux-gnu']
  );
});
