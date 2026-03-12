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

function runInitialFrontendBuild() {
  const result = spawnSync('pnpm', ['run', 'frontend:build'], {
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runTauriDesktopDev() {
  const args = [
    'exec',
    'tauri',
    'dev',
    '-c',
    'src-tauri/tauri.desktop.conf.json',
    ...process.argv.slice(2),
  ];

  const child = spawn('pnpm', args, {
    env: process.env,
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', (code) => process.exit(code ?? 1));
}

runInitialFrontendBuild();
runTauriDesktopDev();
