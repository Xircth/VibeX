import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { createWorkerHarness } from '@vibex/plugin-sdk/testing';
import definition, { RPC_METHODS } from '../runtime/worker.mjs';

const PLUGIN_ROOT = process.cwd();

test('plugin.json and content.mcp contract are valid v4 declarations', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(PLUGIN_ROOT, '.vibex-plugin', 'plugin.json'),
      'utf8'
    )
  );
  assert.equal(manifest.manifestVersion, 4);
  assert.equal(manifest.apiVersion, '1.0');
  assert.equal(manifest.name, '电脑控制');

  const settingsPage = manifest.integrations.find(
    (item) => item.kind === 'app.settings.page'
  );
  assert.ok(settingsPage, 'must declare app.settings.page integration');
  assert.equal(settingsPage.title, '电脑控制');
  assert.equal(settingsPage.handler, 'surface.createSession');
  assert.equal(settingsPage.remote.module, './view');

  const mcpSpec = JSON.parse(
    fs.readFileSync(
      path.join(PLUGIN_ROOT, 'contents', 'mcps', 'computer-use.json'),
      'utf8'
    )
  );
  assert.equal(mcpSpec.tools.length, 18);
});

test('worker registers all required handlers and talks to the native computer daemon', async () => {
  const tempDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vibex-computer-use-test-')
  );
  process.env.VIBEX_PLUGIN_DATA_DIR = tempDataDir;

  const worker = await createWorkerHarness(definition);
  const rpc = (rpcMethod, rpcParams = {}) =>
    worker.invoke('surface.createSession', { rpcMethod, rpcParams });
  try {
    assert.deepEqual(worker.handlers, ['surface.createSession']);

    const health = await rpc('runtime.healthcheck', {});
    assert.equal(
      health.healthy,
      true,
      `Daemon should be healthy: ${JSON.stringify(health)}`
    );
    assert.equal(health.status, 'running');

    const session = await worker.invoke('surface.createSession', {
      surfaceId: 'computer-use',
    });
    assert.equal(session.ready, true);
    assert.equal(session.title, '电脑控制');
    assert.ok(session.state, 'session.state must be returned');
    assert.equal(session.state.settings.enabled, false);
    assert.equal(session.state.driverInfo.version, '0.32.0');
    assert.ok(Array.isArray(session.state.settings.defaultBlocklist));
    assert.ok(session.state.settings.defaultBlocklist.length > 0);

    // Enable computer use and verify tool exposure
    const enabledSettings = await rpc('computer.setEnabled', {
      enabled: true,
    });
    assert.equal(enabledSettings.enabled, true);

    const baseTools = await rpc('mcp.listTools', {});
    assert.equal(baseTools.tools.length, 14);

    // Enable launch, clipboard, and screen sharing preferences
    const prefSettings = await rpc('computer.setPreferences', {
      grantTimeoutSecs: 900,
      launchEnabled: true,
      clipboardEnabled: true,
      screenEnabled: true,
      allowForeground: true,
      defaultDelivery: 'background',
      showIndicator: true,
      customBlocklist: ['secret-app.exe'],
    });
    assert.equal(prefSettings.grantTimeoutSecs, 900);
    assert.equal(prefSettings.launchEnabled, true);
    assert.equal(prefSettings.clipboardEnabled, true);
    assert.equal(prefSettings.screenEnabled, true);
    assert.deepEqual(prefSettings.customBlocklist, ['secret-app.exe']);

    const allTools = await rpc('mcp.listTools', {});
    assert.equal(allTools.tools.length, 18);

    // Call computer_list_windows via daemon MCP dispatcher
    const listWinResult = await rpc('mcp.callTool', {
      name: 'computer_list_windows',
      arguments: {},
    });
    assert.ok(Array.isArray(listWinResult.content));
    assert.equal(listWinResult.content[0].type, 'text');

    // Emergency stop & revokeAll
    await rpc('computer.stop', {});
    const sharedAfterStop = await rpc('computer.sharedState', {});
    assert.deepEqual(sharedAfterStop.shared, []);

    await rpc('computer.setEnabled', { enabled: false });
  } finally {
    await worker.dispose();
  }
});

test('packaged stdio MCP server responds to initialize, tools/list, and tools/call', async () => {
  const mcpEntry = path.join(PLUGIN_ROOT, 'dist', 'mcp', 'computer-use.mjs');
  assert.ok(fs.existsSync(mcpEntry), 'dist/mcp/computer-use.mjs must exist');

  const child = spawn(process.execPath, [mcpEntry], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: child.stdout });
  const responses = new Map();
  const waiters = new Map();

  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id != null) {
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      } else {
        responses.set(msg.id, msg);
      }
    }
  });

  const request = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for MCP response ${id}`)),
        8000
      );
      if (responses.has(id)) {
        clearTimeout(timer);
        const res = responses.get(id);
        responses.delete(id);
        resolve(res);
        return;
      }
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      );
    });

  try {
    const initRes = await request(1, 'initialize', {
      protocolVersion: '2026-07-28',
    });
    assert.equal(initRes.result.protocolVersion, '2026-07-28');
    assert.equal(initRes.result.serverInfo.name, 'vibex-computer-use');

    const listRes = await request(2, 'tools/list', {});
    assert.ok(Array.isArray(listRes.result.tools));
    assert.ok(listRes.result.tools.length >= 14);
  } finally {
    rl.close();
    child.kill();
  }
});
