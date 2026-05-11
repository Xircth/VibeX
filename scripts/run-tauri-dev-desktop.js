#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getPorts } = require('./setup-dev-environment');

const GENERATED_TAURI_DEV_CONFIG = 'src-tauri/tauri.dev.generated.conf.json';

function runCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', command, ...args],
      options
    );
  }

  return spawn(command, args, options);
}

function createCargoLeanDevEnv(ports) {
  return {
    ...process.env,
    CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL || '0',
    FRONTEND_PORT: String(ports.frontend),
    BACKEND_PORT: String(ports.backend),
  };
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
$target = [System.IO.Path]::GetFullPath('${executablePath.replace(/\\/g, '\\\\')}')
$processes = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) }
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
`;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript],
    {
      env: process.env,
      stdio: 'inherit',
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function writeGeneratedTauriDevConfig(ports) {
  const baseConfigPath = path.join(process.cwd(), 'src-tauri', 'tauri.conf.json');
  const generatedConfigPath = path.join(process.cwd(), GENERATED_TAURI_DEV_CONFIG);
  const config = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));

  config.build = {
    ...config.build,
    beforeDevCommand: `pnpm --filter ./frontend dev --host 127.0.0.1 --port ${ports.frontend} --strictPort`,
    devUrl: `http://127.0.0.1:${ports.frontend}`,
    frontendDist: '../frontend/dist',
  };

  fs.writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function runTauriDesktopDev() {
  const ports = await getPorts();
  writeGeneratedTauriDevConfig(ports);

  const env = createCargoLeanDevEnv(ports);
  clearRelocatedCargoBuildCache();
  clearIncrementalCacheIfDisabled(env);
  terminateStaleDesktopProcess();

  const child = runCommand(
    'pnpm',
    [
      'exec',
      'tauri',
      'dev',
      '-c',
      GENERATED_TAURI_DEV_CONFIG.replace(/\\/g, '/'),
      ...process.argv.slice(2),
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

  child.on('exit', (code) => process.exit(code ?? 1));
}

runTauriDesktopDev().catch((error) => {
  console.error(error);
  process.exit(1);
});
