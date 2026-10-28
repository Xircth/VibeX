const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applySidecarDevEnv,
  isHostSidecarSourcePath,
  rebuildHostSidecars,
  sidecarDebugBinary,
  watchHostSidecars,
} = require('./watch-host-sidecars');

const exe = process.platform === 'win32' ? '.exe' : '';

test('desktop dev points official MCP sidecars at the debug cargo outputs', () => {
  const env = applySidecarDevEnv(
    { CARGO_TARGET_DIR: '/custom-target' },
    { repo: '/repo', platform: 'win32' }
  );

  assert.equal(
    env.VIBEX_MCP_BIN,
    path.join('/custom-target', 'debug', 'vibex-mcp.exe')
  );
  assert.equal(
    env.VIBEX_WORKFLOW_MCP_BIN,
    path.join('/custom-target', 'debug', 'vibex-workflow-mcp.exe')
  );
});

test('sidecar debug binaries fall back to the workspace target directory', () => {
  assert.equal(
    sidecarDebugBinary('vibex-mcp', {
      repo: '/repo',
      env: {},
      platform: 'linux',
    }),
    path.join('/repo', 'target', 'debug', 'vibex-mcp')
  );
});

test('an explicit VIBEX_MCP_BIN override is preserved', () => {
  const env = applySidecarDevEnv(
    { VIBEX_MCP_BIN: '/opt/custom-mcp' },
    { repo: '/repo', platform: 'linux' }
  );

  assert.equal(env.VIBEX_MCP_BIN, '/opt/custom-mcp');
  assert.equal(
    env.VIBEX_WORKFLOW_MCP_BIN,
    path.join('/repo', 'target', 'debug', 'vibex-workflow-mcp')
  );
});

test('only official product MCP crates trigger a sidecar rebuild', () => {
  const repo = '/repo';
  assert.equal(
    isHostSidecarSourcePath(path.join(repo, 'crates/vibex-mcp/src/main.rs'), repo),
    true
  );
  assert.equal(
    isHostSidecarSourcePath(
      path.join(repo, 'crates/vibex-mcp/tool_schema.json'),
      repo
    ),
    true
  );
  assert.equal(
    isHostSidecarSourcePath(
      path.join(repo, 'crates/delegation-proto/src/lib.rs'),
      repo
    ),
    true
  );
  assert.equal(
    isHostSidecarSourcePath(
      path.join(repo, 'crates/vibex-workflow-mcp/src/main.rs'),
      repo
    ),
    true
  );
  assert.equal(
    isHostSidecarSourcePath(path.join(repo, 'crates/delegation/src/lib.rs'), repo),
    false
  );
  assert.equal(
    isHostSidecarSourcePath(path.join(repo, 'frontend/src/App.tsx'), repo),
    false
  );
  assert.equal(
    isHostSidecarSourcePath(
      path.join(repo, 'target/debug/vibex-mcp.exe'),
      repo
    ),
    false
  );
});

test('rebuildHostSidecars frees locked debug binaries then cargo-builds both sidecars', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-sidecar-rebuild-'));
  const debugDir = path.join(repo, 'target', 'debug');
  fs.mkdirSync(debugDir, { recursive: true });
  const locked = path.join(debugDir, `vibex-mcp${exe}`);
  fs.writeFileSync(locked, 'old');

  const cargoCalls = [];
  const staged = [];
  rebuildHostSidecars({
    repo,
    env: { CARGO_TARGET_DIR: path.join(repo, 'target') },
    spawnSyncFn: (command, args, options) => {
      cargoCalls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    },
    stageFn: (env) => {
      staged.push(env.CARGO_TARGET_DIR);
    },
  });

  assert.equal(fs.existsSync(locked), false);
  assert.equal(cargoCalls.length, 1);
  assert.equal(cargoCalls[0].command, 'cargo');
  assert.deepEqual(cargoCalls[0].args, [
    'build',
    '-p',
    'vibex-mcp',
    '-p',
    'vibex-workflow-mcp',
  ]);
  assert.equal(cargoCalls[0].cwd, repo);
  assert.deepEqual(staged, [path.join(repo, 'target')]);
});

test('watchHostSidecars rebuilds after a sidecar source change', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-sidecar-watch-'));
  const srcDir = path.join(repo, 'crates', 'vibex-mcp', 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const file = path.join(srcDir, 'main.rs');
  fs.writeFileSync(file, 'fn main() {}\n');

  let calls = 0;
  const watch = watchHostSidecars({
    repo,
    debounceMs: 40,
    rebuild: () => {
      calls += 1;
    },
  });

  try {
    fs.writeFileSync(file, 'fn main() { /* hot */ }\n');
    const started = Date.now();
    while (calls < 1 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(calls >= 1, `expected a sidecar rebuild, got ${calls}`);
  } finally {
    watch.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
