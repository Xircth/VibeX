import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

test('桌面开发启动前清除旧 Cargo debug 产物并保留 CEF runtime', () => {
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
