const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  copySidecar,
  isBuiltSidecar,
  resolveSidecarBinDir,
  resolveSidecarSource,
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

test('sidecar layout prefers DIMO_BUILD_TARGET and the active cargo profile', () => {
  const resolved = resolveSidecarBinDir({
    repo: '/repo',
    env: {
      CARGO_TARGET_DIR: '/custom-target',
      CARGO_PROFILE: 'debug',
      TAURI_ENV_TARGET_TRIPLE: 'ignored-triple',
      DIMO_BUILD_TARGET: 'aarch64-pc-windows-msvc',
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

test('sidecar rebuild is skipped only when both Host binaries are non-empty', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-sidecars-'));
  const env = {
    CARGO_TARGET_DIR: path.join(repo, 'target'),
    DIMO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
    CARGO_PROFILE: 'release',
  };
  const binDir = path.join(
    env.CARGO_TARGET_DIR,
    'x86_64-unknown-linux-gnu',
    'release'
  );
  fs.mkdirSync(binDir, { recursive: true });

  const probe = {
    repo,
    env,
    hostTriple: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
  };

  assert.equal(sidecarBinsExist(probe), false);

  fs.writeFileSync(path.join(binDir, 'dimo-mcp'), '');
  fs.writeFileSync(path.join(binDir, 'dimo-workflow-mcp'), '');
  assert.equal(sidecarBinsExist(probe), false);
  assert.equal(isBuiltSidecar(path.join(binDir, 'dimo-mcp')), false);

  fs.writeFileSync(path.join(binDir, 'dimo-mcp'), 'mcp-bin');
  fs.writeFileSync(path.join(binDir, 'dimo-workflow-mcp'), 'workflow-bin');
  assert.equal(sidecarBinsExist(probe), true);
});

test('sidecar lookup accepts a native cargo profile binary when the triple dir is empty', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-sidecars-native-'));
  const env = {
    CARGO_TARGET_DIR: path.join(repo, 'target'),
    DIMO_BUILD_TARGET: 'x86_64-pc-windows-msvc',
    CARGO_PROFILE: 'debug',
  };
  const { binDir, nativeBinDir } = resolveSidecarBinDir({
    repo,
    env,
    hostTriple: 'x86_64-pc-windows-msvc',
  });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(nativeBinDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'dimo-mcp.exe'), '');
  fs.writeFileSync(path.join(binDir, 'dimo-workflow-mcp.exe'), '');
  fs.writeFileSync(path.join(nativeBinDir, 'dimo-mcp.exe'), 'mcp-bin');
  fs.writeFileSync(path.join(nativeBinDir, 'dimo-workflow-mcp.exe'), 'workflow-bin');

  assert.equal(
    sidecarBinsExist({
      repo,
      env,
      hostTriple: 'x86_64-pc-windows-msvc',
      platform: 'win32',
    }),
    true
  );
  assert.equal(
    resolveSidecarSource('dimo-mcp', binDir, nativeBinDir, 'win32'),
    path.join(nativeBinDir, 'dimo-mcp.exe')
  );
});

test('copySidecar refuses to stage an empty placeholder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-sidecars-copy-'));
  const empty = path.join(root, 'dimo-mcp');
  fs.writeFileSync(empty, '');
  assert.throws(
    () => copySidecar('dimo-mcp', empty, path.join(root, 'out'), 'x86_64-unknown-linux-gnu'),
    /empty sidecar/
  );
});

test('copySidecar replaces existing staged binary and sweeps retired leftovers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-sidecars-atomic-'));
  const src = path.join(root, 'dimo-mcp-src');
  const outDir = path.join(root, 'out');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const triple = 'x86_64-pc-windows-msvc';
  const baseName = `dimo-mcp-${triple}${ext}`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, baseName), 'v1');
  fs.writeFileSync(path.join(outDir, `${baseName}.old-100-1`), 'retired');
  fs.writeFileSync(src, 'v2-fresh');

  copySidecar('dimo-mcp', src, outDir, triple);

  assert.equal(fs.readFileSync(path.join(outDir, baseName), 'utf8'), 'v2-fresh');
  assert.equal(fs.existsSync(path.join(outDir, `${baseName}.old-100-1`)), false);
});
