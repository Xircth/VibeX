#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const { withNativeBuildEnv } = require('./cargo-path');

const workspaceRoot = path.join(__dirname, '..');
const sqlxOfflineDir = path.join(workspaceRoot, 'crates', 'db', '.sqlx');

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

function hasBundleArg(args) {
  return args.some(
    (arg) => arg === '--bundles' || arg === '-b' || arg.startsWith('--bundles=')
  );
}

function getDefaultBundles(platform) {
  switch (platform) {
    case 'win32':
      return 'msi,nsis';
    case 'darwin':
      return 'app,dmg';
    case 'linux':
      return 'appimage,deb';
    default:
      return null;
  }
}

function withTauriBuildEnv(env) {
  return {
    ...withNativeBuildEnv(env),
    SQLX_OFFLINE: env.SQLX_OFFLINE || 'true',
    SQLX_OFFLINE_DIR: env.SQLX_OFFLINE_DIR || sqlxOfflineDir,
  };
}

const userArgs = process.argv
  .slice(2)
  .filter((arg, index) => !(index === 0 && arg === '--'));
const defaultBundles = getDefaultBundles(process.platform);
const bundleArgs =
  defaultBundles && !hasBundleArg(userArgs)
    ? ['--bundles', defaultBundles]
    : [];
const buildArgs = ['exec', 'tauri', 'build', ...bundleArgs, ...userArgs];

if (bundleArgs.length > 0) {
  console.log(`Using default Tauri bundles for ${process.platform}: ${defaultBundles}`);
}

const child = runCommand(
  'pnpm',
  buildArgs,
  {
    env: withTauriBuildEnv(process.env),
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
