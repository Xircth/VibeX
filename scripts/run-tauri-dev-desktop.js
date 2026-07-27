#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withNativeBuildEnv } = require('./cargo-path');
const { resetCargoDebugTarget } = require('./cargo-dev-target');
const { getPorts } = require('./setup-dev-environment');

const GENERATED_TAURI_DEV_CONFIG = 'src-tauri/tauri.dev.generated.conf.json';

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

function createCargoLeanDevEnv(ports) {
  return withNativeBuildEnv({
    ...process.env,
    CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL || '0',
    FRONTEND_PORT: String(ports.frontend),
    BACKEND_PORT: String(ports.backend),
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

  const powershellScript = `
$target = [System.IO.Path]::GetFullPath($env:VIBEX_STALE_EXE_PATH)
$processes = Get-Process -Name 'vibex' -ErrorAction SilentlyContinue | Where-Object {
  try {
    $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $target)
  } catch {
    $false
  }
}
foreach ($process in $processes) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
exit 0
`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript],
    {
      env: {
        ...process.env,
        VIBEX_STALE_EXE_PATH: executablePath,
      },
      stdio: 'inherit',
      timeout: 10000,
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
  const config = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));

  config.build = {
    ...config.build,
    beforeDevCommand: `pnpm --filter ./frontend dev --host 127.0.0.1 --port ${ports.frontend} --strictPort`,
    devUrl: `http://127.0.0.1:${ports.frontend}`,
    frontendDist: '../frontend/dist',
  };

  fs.writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

function hasRunnerArg(args) {
  return args.some(
    (arg) => arg === '--runner' || arg === '-r' || arg.startsWith('--runner=')
  );
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

async function runTauriDesktopDev() {
  const ports = await getPorts();
  writeGeneratedTauriDevConfig(ports);

  const env = createCargoLeanDevEnv(ports);
  clearRelocatedCargoBuildCache();
  clearIncrementalCacheIfDisabled(env);
  terminateStaleDesktopProcess();
  const debugTarget = path.join(process.cwd(), 'target', 'debug');
  if (fs.existsSync(debugTarget)) {
    console.warn('Removing previous Cargo debug artifacts before Tauri dev.');
  }
  if (resetCargoDebugTarget(process.cwd())) {
    console.warn('Removed previous Cargo debug artifacts.');
  }

  const userArgs = process.argv.slice(2);
  const runnerArgs =
    process.platform === 'darwin' && !hasRunnerArg(userArgs)
      ? [
          '--runner',
          path.join(process.cwd(), 'scripts', 'run-tauri-dev-macos.js'),
        ]
      : [];

  const child = runCommand(
    'pnpm',
    [
      'exec',
      'tauri',
      'dev',
      '-c',
      GENERATED_TAURI_DEV_CONFIG.replace(/\\/g, '/'),
      ...runnerArgs,
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

runTauriDesktopDev().catch((error) => {
  console.error(error);
  process.exit(1);
});
