const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  helperBuildArgs,
  resolveProfileBin,
  stagerBuildArgs,
} = require('./stage-cef-runtime');

test('release CEF staging builds the helper and stager instead of cargo run', () => {
  const helper = helperBuildArgs({
    debug: false,
    target: 'x86_64-apple-darwin',
  });
  const stager = stagerBuildArgs({
    debug: false,
    target: 'x86_64-apple-darwin',
  });

  assert.equal(helper[0], 'build');
  assert.deepEqual(helper.slice(helper.indexOf('--bin'), helper.indexOf('--bin') + 2), [
    '--bin',
    'vibex_cef_helper',
  ]);
  assert.ok(helper.includes('--release'));
  assert.deepEqual(
    helper.slice(helper.indexOf('--target'), helper.indexOf('--target') + 2),
    ['--target', 'x86_64-apple-darwin']
  );

  assert.equal(stager[0], 'build');
  assert.equal(stager.includes('run'), false);
  assert.ok(stager.includes('--release'));
  assert.deepEqual(
    stager.slice(stager.indexOf('--bin'), stager.indexOf('--bin') + 2),
    ['--bin', 'stage_cef_runtime']
  );
});

test('debug CEF staging keeps the debug profile and omits --release', () => {
  const stager = stagerBuildArgs({ debug: true, target: null });

  assert.equal(stager[0], 'build');
  assert.equal(stager.includes('--release'), false);
  assert.equal(stager.includes('--target'), false);
});

test('CEF binaries resolve under the cargo target triple directory', () => {
  assert.equal(
    resolveProfileBin({
      targetRoot: '/repo/target',
      target: 'aarch64-apple-darwin',
      profile: 'release',
      name: 'stage_cef_runtime',
      platform: 'darwin',
    }),
    path.join(
      '/repo/target',
      'aarch64-apple-darwin',
      'release',
      'stage_cef_runtime'
    )
  );
  assert.equal(
    resolveProfileBin({
      targetRoot: '/repo/target',
      target: null,
      profile: 'debug',
      name: 'vibex_cef_helper',
      platform: 'win32',
    }),
    path.join('/repo/target', 'debug', 'vibex_cef_helper.exe')
  );
});
