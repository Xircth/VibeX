#!/usr/bin/env node

/**
 * Desktop-only Tauri dev launcher.
 *
 * Why this wrapper exists:
 * - `beforeDevCommand` runs in parallel with the Rust app build.
 * - Tauri needs `frontend/dist` to exist before `generate_context!()` runs.
 * - So we force one synchronous frontend build first, then start Tauri dev,
 *   which keeps `vite build --watch` alive through `beforeDevCommand`.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommandSync(command, args, options = {}) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', command, ...args],
      options
    );
    return result;
  }

  return spawnSync(command, args, options);
}

function runCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], options);
  }

  return spawn(command, args, options);
}

function createCargoLeanDevEnv() {
  return {
    ...process.env,
    CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL || '0',
  };
}

function clearIncrementalCacheIfDisabled(env) {
  if (env.CARGO_INCREMENTAL !== '0') {
    return;
  }

  const incrementalPath = path.join(process.cwd(), 'target', 'debug', 'incremental');
  if (!fs.existsSync(incrementalPath)) {
    return;
  }

  fs.rmSync(incrementalPath, { recursive: true, force: true });
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

function runInitialFrontendBuild() {
  const result = runCommandSync('pnpm', ['run', 'frontend:build'], {
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error('Failed to start frontend build:', result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runTauriDesktopDev() {
  const env = createCargoLeanDevEnv();
  const args = [
    'exec',
    'tauri',
    'dev',
    '-c',
    'src-tauri/tauri.desktop.conf.json',
    ...process.argv.slice(2),
  ];

  const child = runCommand('pnpm', args, {
    env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error('Failed to start Tauri dev:', error.message);
    process.exit(1);
  });

  child.on('exit', (code) => process.exit(code ?? 1));
}

runInitialFrontendBuild();
terminateStaleDesktopProcess();
clearIncrementalCacheIfDisabled(createCargoLeanDevEnv());
runTauriDesktopDev();
