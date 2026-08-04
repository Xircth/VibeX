import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

test('桌面开发启动复用有效的 Cargo debug 产物', () => {
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vibex-cargo-dev-launcher-')
  );
  const fakeBin = path.join(workspaceRoot, 'bin');
  const fakePnpm = path.join(fakeBin, 'pnpm');
  const pnpmArgs = path.join(workspaceRoot, 'pnpm-args.json');
  const cachedArtifact = path.join(
    workspaceRoot,
    'target',
    'debug',
    'deps',
    'cached-artifact'
  );

  try {
    fs.mkdirSync(path.join(workspaceRoot, 'src-tauri'), { recursive: true });
    fs.mkdirSync(path.dirname(cachedArtifact), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'src-tauri', 'tauri.conf.json'),
      JSON.stringify({ build: {} })
    );
    fs.writeFileSync(cachedArtifact, 'reusable build');
    fs.writeFileSync(
      fakePnpm,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(
  process.env.FAKE_PNPM_ARGS,
  JSON.stringify(process.argv.slice(2))
);
`
    );
    fs.chmodSync(fakePnpm, 0o755);

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'run-tauri-dev-desktop.js')],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_PNPM_ARGS: pnpmArgs,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          PORT: '48123',
        },
        timeout: 5000,
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(cachedArtifact), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(pnpmArgs, 'utf8')).slice(0, 3),
      ['exec', 'tauri', 'dev']
    );
  } finally {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  }
});

test('显式重置 Cargo debug 产物时保留 CEF runtime', () => {
  const { resetCargoDebugTarget } = require(
    path.join(repoRoot, 'scripts', 'cargo-dev-target.js')
  );
  const workspaceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vibex-cargo-dev-target-')
  );
  const oldDebugArtifact = path.join(
    workspaceRoot,
    'target',
    'debug',
    'deps',
    'old-artifact'
  );
  const liveCefRuntime = path.join(
    workspaceRoot,
    'target',
    'cef-runtime',
    'macos',
    'app',
    'vibex'
  );

  try {
    fs.mkdirSync(path.dirname(oldDebugArtifact), { recursive: true });
    fs.mkdirSync(path.dirname(liveCefRuntime), { recursive: true });
    fs.writeFileSync(oldDebugArtifact, 'old build');
    fs.writeFileSync(liveCefRuntime, 'live runtime');

    assert.equal(resetCargoDebugTarget(workspaceRoot), true);
    assert.equal(fs.existsSync(oldDebugArtifact), false);
    assert.equal(fs.existsSync(liveCefRuntime), true);
    assert.equal(resetCargoDebugTarget(workspaceRoot), false);
  } finally {
    fs.rmSync(workspaceRoot, { force: true, recursive: true });
  }
});
