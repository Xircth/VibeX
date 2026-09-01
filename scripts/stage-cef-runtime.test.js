const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  helperBuildArgs,
  resolveProfileBin,
  stagerBuildArgs,
  findCefLibraryDir,
  withCefLibraryPath,
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

test('Linux stager execution prepends the CEF library directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-cef-'));
  const libraryDir = path.join(root, 'cef_binary', 'Release');
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(path.join(libraryDir, 'libcef.so'), '');

  assert.equal(findCefLibraryDir([root], 'linux'), libraryDir);
  assert.equal(
    withCefLibraryPath(
      { CEF_PATH: root, LD_LIBRARY_PATH: '/usr/lib' },
      { platform: 'linux' }
    ).LD_LIBRARY_PATH,
    `${libraryDir}:/usr/lib`
  );
});

test('already-staged CEF runtime is detected from the manifest and required files', () => {
  const { isCefRuntimeStaged } = require('./stage-cef-runtime');
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-cef-stage-'));
  const stageRoot = path.join(targetRoot, 'cef-runtime', 'linux');
  fs.mkdirSync(stageRoot, { recursive: true });

  assert.equal(isCefRuntimeStaged({}, { targetRoot, platform: 'linux' }), false);

  fs.writeFileSync(
    path.join(stageRoot, 'cef-runtime-manifest.json'),
    JSON.stringify({ requiredFiles: ['libcef.so'] })
  );
  assert.equal(isCefRuntimeStaged({}, { targetRoot, platform: 'linux' }), false);

  fs.writeFileSync(path.join(stageRoot, 'libcef.so'), '');
  assert.equal(isCefRuntimeStaged({}, { targetRoot, platform: 'linux' }), true);
});
