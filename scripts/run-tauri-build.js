#!/usr/bin/env node

const { spawn } = require('child_process');
const { withNativeBuildEnv } = require('./cargo-path');

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

const child = runCommand(
  'pnpm',
  ['exec', 'tauri', 'build', ...process.argv.slice(2)],
  {
    env: withNativeBuildEnv(process.env),
    stdio: 'inherit',
  }
);

child.on('error', (error) => {
  console.error('Failed to start Tauri build:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (code === 0) {
    process.exit(0);
  }

  const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  console.error(`Tauri build exited with ${status}.`);
  process.exit(code ?? 1);
});
