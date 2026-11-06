import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import appModule from '../app/main.js';
import worker from '../runtime/worker.mjs';
import { readSecret, writeSecret } from '../runtime/sidecar.mjs';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('manifest declares status.after-mcp entry, preserves 5 MCP meta-tools and skill, and removes app.tab', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(PLUGIN_ROOT, '.vibex-plugin', 'plugin.json'), 'utf8'),
  );
  assert.equal(manifest.id, 'vibex.open-connector');
  assert.equal(manifest.apiVersion, '2.0');

  const kinds = manifest.integrations.map((item) => item.kind);
  assert.equal(kinds.includes('app.tab'), false, 'must not declare top-level app.tab');

  const statusIntegration = manifest.integrations.find(
    (item) => item.id === 'runtime-status' && item.kind === 'app.status',
  );
  assert.ok(statusIntegration, 'must declare runtime-status app.status integration');
  assert.equal(statusIntegration.slot, 'status.after-mcp');
  assert.equal(statusIntegration.icon, 'plug');

  const mcpIntegration = manifest.integrations.find(
    (item) => item.id === 'mcp' && item.kind === 'content.mcp',
  );
  assert.ok(mcpIntegration, 'must preserve content.mcp integration');
  const mcpSpec = JSON.parse(
    await readFile(path.join(PLUGIN_ROOT, mcpIntegration.resource), 'utf8'),
  );
  assert.deepEqual(
    mcpSpec.tools.map((tool) => tool.name),
    [
      'list_apps',
      'list_connections',
      'search_actions',
      'get_action_guide',
      'execute_action',
    ],
  );

  const skillIntegration = manifest.integrations.find(
    (item) => item.id === 'skill' && item.kind === 'content.skill',
  );
  assert.ok(skillIntegration, 'must preserve content.skill integration');
});

test('app/main.js registers status.after-mcp status item and view without top-level tab', async () => {
  const statusItems = [];
  const views = [];
  const tabs = [];
  const commands = [];
  const slashCommands = [];
  const services = new Map();
  const emittedEvents = [];

  const ctx = {
    pluginId: 'vibex.open-connector',
    worker: {
      async invoke(handler) {
        if (handler === 'runtime.statusText') {
          return { text: 'Open Connector · 运行中' };
        }
        return { state: 'running' };
      },
    },
    events: {
      emit(event, payload) {
        emittedEvents.push({ event, payload });
      },
    },
    ui: {
      registerTab(tab) {
        tabs.push(tab);
      },
      registerView(view) {
        views.push(view);
      },
      registerStatusBarItem(item) {
        statusItems.push(item);
      },
      registerCommand(cmd) {
        commands.push(cmd);
      },
      registerSlashCommand(slash) {
        slashCommands.push(slash);
      },
    },
    services: {
      provide(id, impl) {
        services.set(id, impl);
      },
    },
  };

  appModule.activate(ctx);

  assert.equal(tabs.length, 0, 'must not register any top-level central tab');
  assert.equal(statusItems.length, 1);
  assert.equal(statusItems[0].id, 'runtime-status');
  assert.equal(statusItems[0].slot, 'status.after-mcp');
  assert.equal(statusItems[0].icon, 'plug');

  const statusView = views.find((v) => v.id === 'runtime-status');
  assert.ok(statusView, 'must register runtime-status popover/container view');
  assert.equal(statusView.slot, 'status.after-mcp');
  assert.equal(typeof statusView.component, 'function');

  const settingsView = views.find((v) => v.id === 'settings');
  assert.ok(settingsView, 'must register settings detail view');
  assert.equal(settingsView.slot, 'plugin.detail.panel');

  await statusItems[0].onActivate();
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].event, 'open-connector:open-marketplace');

  assert.equal(commands.length, 1);
  assert.equal(commands[0].id, 'runtime-status-command');
  assert.equal(slashCommands.length, 1);
  assert.equal(slashCommands[0].name, 'connector');
  assert.ok(services.has('vibex.open-connector'));
});

test('registers sidecar handlers and returns without waiting on health', async () => {
  const harness = await createWorkerHarness(worker, {
    host: {
      async call(capability, operation) {
        if (capability === 'runtime.lock' && operation === 'get') {
          throw Object.assign(new Error('runtime_not_locked'), {
            code: 'runtime_not_locked',
          });
        }
        if (capability === 'storage' && operation === 'settings.get') return {};
        return null;
      },
    },
  });
  assert.deepEqual(
    [...harness.handlers].sort(),
    [
      'mcp.endpoint',
      'runtime.health',
      'runtime.restart',
      'runtime.status',
      'runtime.statusText',
      'runtime.wipeData',
      'surface.createSession',
    ].sort(),
  );
  const status = await harness.invoke('surface.createSession');
  assert.equal(typeof status.state, 'string');
  assert.equal(status.adminAuthConfigured, false);
  const text = await harness.invoke('runtime.statusText');
  assert.equal(typeof text.text, 'string');
  await harness.dispose();
});

test('persists bootstrap runtime token as the env value, not a file path', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-secrets-'));
  try {
    const file = path.join(dir, 'runtime.token');
    const token = 'a'.repeat(64);
    await writeSecret(file, token);
    assert.equal(await readSecret(file), token);
    assert.equal((await readFile(file, 'utf8')).trim(), token);
    await writeFile(file, `"${token}"`, 'utf8');
    assert.equal(await readSecret(file), token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
