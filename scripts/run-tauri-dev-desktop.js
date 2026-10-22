#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withNativeBuildEnv } = require('./cargo-path');
const { applyLocalEnvFile } = require('./load-local-env');
const { getPorts } = require('./setup-dev-environment');

const GENERATED_TAURI_DEV_CONFIG = 'src-tauri/tauri.dev.generated.conf.json';
const WORKSPACE_ROOT = path.join(__dirname, '..');
const SQLX_OFFLINE_DIR = path.join(WORKSPACE_ROOT, 'crates', 'db', '.sqlx');
const LOCAL_ENV_FILE = path.join(WORKSPACE_ROOT, '.env.local');
const DESKTOP_DEV_IDENTITY = {
  deepLinkScheme: 'vibex-dev',
  identifier: 'com.vibex.app.dev',
  productName: 'VibeX Dev',
};

function applyDesktopDevIdentity(config) {
  const next = JSON.parse(JSON.stringify(config));
  next.identifier = DESKTOP_DEV_IDENTITY.identifier;
  next.productName = DESKTOP_DEV_IDENTITY.productName;
  for (const window of next.app?.windows ?? []) {
    if (window.title === 'VibeX') {
      window.title = DESKTOP_DEV_IDENTITY.productName;
    }
  }
  const desktop = next.plugins?.['deep-link']?.desktop;
  if (desktop) {
    desktop.schemes = [DESKTOP_DEV_IDENTITY.deepLinkScheme];
  }
  return next;
}

function runCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', command, ...args],
      { ...options, windowsHide: true }
    );
  }

  return spawn(command, args, options);
}

function createCargoLeanDevEnv(ports, baseEnv = process.env) {
  const env = applyLocalEnvFile(LOCAL_ENV_FILE, baseEnv);
  return withNativeBuildEnv({
    ...env,
    CARGO_INCREMENTAL: env.CARGO_INCREMENTAL || '0',
    FRONTEND_PORT: String(ports.frontend),
    BACKEND_PORT: String(ports.backend),
    SQLX_OFFLINE: env.SQLX_OFFLINE || 'true',
    SQLX_OFFLINE_DIR: env.SQLX_OFFLINE_DIR || SQLX_OFFLINE_DIR,
  });
}

function clearIncrementalCacheIfDisabled(env) {
  if (env.CARGO_INCREMENTAL !== '0') {
    return;
  }

  const incrementalPath = path.join(
    process.cwd(),
    'target',
    'debug',
    'incremental'
  );
  if (!fs.existsSync(incrementalPath)) {
    return;
  }

  fs.rmSync(incrementalPath, { recursive: true, force: true });
}

function clearRelocatedCargoBuildCache() {
  const buildPath = path.join(process.cwd(), 'target', 'debug', 'build');
  if (!fs.existsSync(buildPath)) {
    return;
  }

  const workspaceRoot = [
    path.resolve(process.cwd()).toLowerCase(),
    path.sep,
  ].join('');
  const entries = fs.readdirSync(buildPath, { withFileTypes: true });

  const hasRelocatedOutput = entries.some((entry) => {
    if (!entry.isDirectory()) {
      return false;
    }

    const rootOutputPath = path.join(buildPath, entry.name, 'root-output');
    if (!fs.existsSync(rootOutputPath)) {
      return false;
    }

    let outputPath;
    try {
      outputPath = fs.readFileSync(rootOutputPath, 'utf8').trim();
    } catch {
      return false;
    }

    if (!path.isAbsolute(outputPath)) {
      return false;
    }

    return !path.resolve(outputPath).toLowerCase().startsWith(workspaceRoot);
  });

  if (!hasRelocatedOutput) {
    return;
  }

  console.warn(
    'Detected relocated Cargo build cache; removing target/debug/build.'
  );
  fs.rmSync(buildPath, { recursive: true, force: true });
}

function terminateStaleDesktopProcess() {
  if (process.platform !== 'win32') {
    return;
  }

  const executablePath = path.join(
    process.cwd(),
    'target',
    'debug',
    'vibex.exe'
  );

  // One line: multiline -Command scripts are truncated or ignored by
  // CreateProcess, which left a running debug exe locking vibex.exe.
  const powershellScript =
    "$target = [System.IO.Path]::GetFullPath($env:VIBEX_STALE_EXE_PATH); " +
    "Get-CimInstance Win32_Process -Filter \"Name = 'vibex.exe'\" | " +
    'Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) } | ' +
    'ForEach-Object { taskkill.exe /F /PID $_.ProcessId /T | Out-Null; ' +
    'Wait-Process -Id $_.ProcessId -Timeout 8 -ErrorAction SilentlyContinue }';

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript],
    {
      env: {
        ...process.env,
        VIBEX_STALE_EXE_PATH: executablePath,
      },
      stdio: 'inherit',
      timeout: 15000,
      windowsHide: true,
    }
  );

  if (result.error) {
    console.error(
      'Failed to terminate stale desktop process:',
      result.error.message
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  waitUntilDebugExeWritable(executablePath);
}

function waitUntilDebugExeWritable(executablePath) {
  const deadline = Date.now() + 8000;
  while (Date.now() <= deadline) {
    try {
      fs.closeSync(fs.openSync(executablePath, 'r+'));
      return;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      if (
        !error ||
        (error.code !== 'EBUSY' &&
          error.code !== 'EPERM' &&
          error.code !== 'EACCES')
      ) {
        return;
      }
      spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'ping 127.0.0.1 -n 2 >nul'], {
        windowsHide: true,
        timeout: 3000,
      });
    }
  }

  console.error(
    `Debug executable is still locked: ${executablePath}. Close the running VibeX Dev window and retry.`
  );
  process.exit(1);
}

function writeGeneratedTauriDevConfig(ports) {
  const baseConfigPath = path.join(
    process.cwd(),
    'src-tauri',
    'tauri.conf.json'
  );
  const generatedConfigPath = path.join(
    process.cwd(),
    GENERATED_TAURI_DEV_CONFIG
  );
  const config = applyDesktopDevIdentity(
    JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'))
  );

  config.build = {
    ...config.build,
    beforeDevCommand: `pnpm --filter ./frontend dev --host 127.0.0.1 --port ${ports.frontend} --strictPort`,
    devUrl: `http://127.0.0.1:${ports.frontend}`,
    frontendDist: '../frontend/dist',
  };

  fs.writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

function describeTauriDevExit(code, signal, ports) {
  if (code === 0) {
    return;
  }

  const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  console.error(`Tauri dev exited with ${status}.`);
  console.error(
    `Dev ports: frontend=${ports.frontend}, backend=${ports.backend}.`
  );
  console.error(`Generated config: ${GENERATED_TAURI_DEV_CONFIG}.`);
}

function resolveRustHostTriple(env) {
  const result = spawnSync('rustc', ['-vV'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const match = String(result.stdout || '').match(/^host:\s*(\S+)/m);
  if (match && match[1]) {
    return match[1].trim();
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin';
  }
  return 'x86_64-unknown-linux-gnu';
}

function prepareHostSidecars(env) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (process.platform === 'win32') {
    for (const name of ['vibex-mcp', 'vibex-workflow-mcp']) {
      const binPath = path.join(WORKSPACE_ROOT, "target", "debug", name + ext); if (fs.existsSync(binPath)) { try { fs.unlinkSync(binPath); } catch { try { fs.renameSync(binPath, binPath + ".old-" + Date.now()); } catch {} } }
    }
  }
  const build = spawnSync(
    'cargo',
    ['build', '-p', 'vibex-mcp', '-p', 'vibex-workflow-mcp'],
    {
      cwd: WORKSPACE_ROOT,
      env,
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  if (build.status !== 0) {
    console.warn('Warning: cargo build -p vibex-mcp returned non-zero status.');
    return;
  }
  const triple = resolveRustHostTriple(env);
  const binariesDir = path.join(WORKSPACE_ROOT, 'src-tauri', 'binaries');
  fs.mkdirSync(binariesDir, { recursive: true });
  for (const name of ['vibex-mcp', 'vibex-workflow-mcp']) {
    const src = path.join(WORKSPACE_ROOT, 'target', 'debug', `${name}${ext}`);
    const dst = path.join(binariesDir, `${name}-${triple}${ext}`);
    if (fs.existsSync(src) && fs.statSync(src).size > 0) {
      fs.copyFileSync(src, dst);
    }
  }
}

async function runTauriDesktopDev() {
  const ports = await getPorts();
  writeGeneratedTauriDevConfig(ports);

  const env = createCargoLeanDevEnv(ports);
  clearRelocatedCargoBuildCache();
  clearIncrementalCacheIfDisabled(env);
  terminateStaleDesktopProcess();
  prepareHostSidecars(env);

  const userArgs = process.argv.slice(2);

  const child = runCommand(
    'pnpm',
    [
      'exec',
      'tauri',
      'dev',
      '-c',
      GENERATED_TAURI_DEV_CONFIG.replace(/\\/g, '/'),
      ...userArgs,
    ],
    {
      env,
      stdio: 'inherit',
    }
  );

  child.on('error', (error) => {
    console.error('Failed to start Tauri dev:', error.message);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    describeTauriDevExit(code, signal, ports);
    process.exit(code ?? 1);
  });
}

if (require.main === module) {
  runTauriDesktopDev().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  applyDesktopDevIdentity,
  createCargoLeanDevEnv,
  DESKTOP_DEV_IDENTITY,
};
