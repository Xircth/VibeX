import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import worker from '../runtime/worker.mjs';
import { readSecret, writeSecret } from '../runtime/sidecar.mjs';

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
