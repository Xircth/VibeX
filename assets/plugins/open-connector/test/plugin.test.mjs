import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import worker from '../runtime/worker.mjs';

test('registers sidecar handlers and returns without waiting on health', async () => {
  const harness = await createWorkerHarness(worker, {
    host: {
      async call(capability, operation) {
        if (capability === 'runtime.lock' && operation === 'get') {
          throw Object.assign(new Error('runtime_not_locked'), {
            code: 'runtime_not_locked',
          });
        }
        if (capability === 'storage.settings.get') return {};
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
