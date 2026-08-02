const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const binary = path.join(
  root,
  'target',
  'release',
  process.platform === 'win32' ? 'vibex-server.exe' : 'vibex-server',
);
const staticRoot = path.join(root, 'frontend', 'dist');
const token = 'package-smoke-token-that-is-never-logged';

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHealth(port, child, readSpawnError) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (readSpawnError()) throw readSpawnError();
    if (child.exitCode !== null) {
      throw new Error(`vibex-server exited early with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Startup and migrations are still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for packaged vibex-server');
}

async function main() {
  if (!fs.existsSync(staticRoot)) {
    throw new Error('frontend/dist is missing; run pnpm run frontend:build');
  }
  const build = spawnSync(
    'cargo',
    ['build', '--release', '-p', 'server', '--bin', 'vibex-server'],
    {
      cwd: root,
      env: {
        ...process.env,
        CARGO_PROFILE_RELEASE_DEBUG: '0',
        CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: 'off',
      },
      stdio: 'inherit',
    },
  );
  if (build.status !== 0) process.exit(build.status || 1);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-server-smoke-'));
  const port = await reservePort();
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      VIBEX_DATA_DIR: dataDir,
      VIBEX_STATIC_ROOT: staticRoot,
      VIBEX_SERVER_LISTEN: `127.0.0.1:${port}`,
      VIBEX_SERVER_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  try {
    await waitForHealth(port, child, () => spawnError);
    const missing = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`);
    if (missing.status !== 401) {
      throw new Error(`unauthenticated capabilities returned ${missing.status}`);
    }
    const capabilities = await fetch(
      `http://127.0.0.1:${port}/api/v1/capabilities`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!capabilities.ok) {
      throw new Error(`authenticated capabilities returned ${capabilities.status}`);
    }
    const document = await capabilities.json();
    if (document.protocol_version !== '1.0') {
      throw new Error(`unexpected protocol ${document.protocol_version}`);
    }
  } finally {
    if (!spawnError) {
      child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', resolve);
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (output.includes(token)) {
    throw new Error('packaged server output leaked the supplied token');
  }
  process.stdout.write('packaged vibex-server smoke passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
