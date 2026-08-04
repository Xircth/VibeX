import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for dev runner fixture');
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test(
  'macOS dev runner terminates an in-flight Cargo build when restarted',
  { skip: process.platform !== 'darwin' },
  async () => {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), 'vibex-tauri-runner-')
    );
    const fakeCargo = path.join(fixture, 'fake-cargo.js');
    const cargoPidFile = path.join(fixture, 'cargo.pid');
    const cargoStoppedFile = path.join(fixture, 'cargo.stopped');
    let cargoPid;
    let runner;

    try {
      fs.writeFileSync(
        fakeCargo,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CARGO_PID_FILE, String(process.pid));
process.once('SIGTERM', () => {
  fs.writeFileSync(process.env.FAKE_CARGO_STOPPED_FILE, 'stopped');
  process.exit(0);
});
setInterval(() => {}, 1000);
`
      );
      fs.chmodSync(fakeCargo, 0o755);

      runner = spawn(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js'),
          'run',
          '--no-default-features',
          '--',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CARGO: fakeCargo,
            FAKE_CARGO_PID_FILE: cargoPidFile,
            FAKE_CARGO_STOPPED_FILE: cargoStoppedFile,
          },
          stdio: 'ignore',
        }
      );

      await waitFor(() => fs.existsSync(cargoPidFile));
      cargoPid = Number.parseInt(fs.readFileSync(cargoPidFile, 'utf8'), 10);
      assert.equal(isProcessRunning(cargoPid), true);

      runner.kill('SIGTERM');
      await new Promise((resolve) => runner.once('exit', resolve));
      await waitFor(() => !isProcessRunning(cargoPid), 1000);

      assert.equal(fs.existsSync(cargoStoppedFile), true);
    } finally {
      if (runner && runner.exitCode === null) runner.kill('SIGKILL');
      if (cargoPid && isProcessRunning(cargoPid)) {
        process.kill(cargoPid, 'SIGKILL');
      }
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  }
);

test(
  'macOS dev runner reclaims an orphaned Cargo build after a forced restart',
  { skip: process.platform !== 'darwin' },
  async () => {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), 'vibex-tauri-forced-restart-')
    );
    const fakeCargo = path.join(fixture, 'fake-cargo.js');
    const firstMarker = path.join(fixture, 'first.marker');
    const firstPidFile = path.join(fixture, 'first.pid');
    const firstStoppedFile = path.join(fixture, 'first.stopped');
    const replacementStartedFile = path.join(fixture, 'replacement.started');
    let firstCargoPid;
    let firstRunner;
    let replacementRunner;

    try {
      fs.writeFileSync(
        fakeCargo,
        `#!/usr/bin/env node
const fs = require('node:fs');
try {
  fs.writeFileSync(process.env.FIRST_MARKER, 'first', { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  fs.writeFileSync(process.env.REPLACEMENT_STARTED_FILE, 'started');
  process.exit(19);
}
fs.writeFileSync(process.env.FIRST_PID_FILE, String(process.pid));
process.once('SIGTERM', () => {
  fs.writeFileSync(process.env.FIRST_STOPPED_FILE, 'stopped');
  process.exit(0);
});
setInterval(() => {}, 1000);
`
      );
      fs.chmodSync(fakeCargo, 0o755);

      const env = {
        ...process.env,
        CARGO: fakeCargo,
        CARGO_TARGET_DIR: path.join(fixture, 'target'),
        FIRST_MARKER: firstMarker,
        FIRST_PID_FILE: firstPidFile,
        FIRST_STOPPED_FILE: firstStoppedFile,
        REPLACEMENT_STARTED_FILE: replacementStartedFile,
      };
      const runnerArgs = [
        path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js'),
        'run',
        '--no-default-features',
        '--',
      ];

      firstRunner = spawn(process.execPath, runnerArgs, {
        cwd: repoRoot,
        env,
        stdio: 'ignore',
      });
      await waitFor(() => fs.existsSync(firstPidFile));
      firstCargoPid = Number.parseInt(
        fs.readFileSync(firstPidFile, 'utf8'),
        10
      );

      const firstRunnerExited = new Promise((resolve) =>
        firstRunner.once('exit', resolve)
      );
      firstRunner.kill('SIGKILL');
      await firstRunnerExited;
      assert.equal(isProcessRunning(firstCargoPid), true);

      replacementRunner = spawn(process.execPath, runnerArgs, {
        cwd: repoRoot,
        env,
        stdio: 'ignore',
      });

      await waitFor(() => fs.existsSync(replacementStartedFile));
      await waitFor(() => !isProcessRunning(firstCargoPid), 1000);
      assert.equal(fs.existsSync(firstStoppedFile), true);
    } finally {
      if (firstRunner && firstRunner.exitCode === null) {
        firstRunner.kill('SIGKILL');
      }
      if (replacementRunner && replacementRunner.exitCode === null) {
        replacementRunner.kill('SIGKILL');
      }
      if (firstCargoPid && isProcessRunning(firstCargoPid)) {
        process.kill(firstCargoPid, 'SIGKILL');
      }
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  }
);

test(
  'macOS dev runner discards a corrupt stale command record',
  { skip: process.platform !== 'darwin' },
  () => {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), 'vibex-tauri-corrupt-record-')
    );
    const targetRoot = path.join(fixture, 'target');
    const commandRecord = path.join(
      targetRoot,
      'cef-runtime',
      'macos',
      'dev-command.pid.json'
    );
    const fakeCargo = path.join(fixture, 'fake-cargo.js');
    const cargoStartedFile = path.join(fixture, 'cargo.started');

    try {
      fs.mkdirSync(path.dirname(commandRecord), { recursive: true });
      fs.writeFileSync(commandRecord, '{"pid":');
      fs.writeFileSync(
        fakeCargo,
        `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.CARGO_STARTED_FILE, 'started');
process.exit(19);
`
      );
      fs.chmodSync(fakeCargo, 0o755);

      spawnSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js'),
          'run',
          '--no-default-features',
          '--',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CARGO: fakeCargo,
            CARGO_STARTED_FILE: cargoStartedFile,
            CARGO_TARGET_DIR: targetRoot,
          },
          stdio: 'ignore',
        }
      );

      assert.equal(fs.existsSync(cargoStartedFile), true);
      assert.equal(fs.existsSync(commandRecord), false);
    } finally {
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  }
);
