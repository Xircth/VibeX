import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import worker from '../runtime/worker.mjs';

/** In-memory stand-in for the Host's `storage.kv` capability. */
function kvHost() {
  const store = new Map();
  return {
    store,
    call(capability, operation, input) {
      assert.equal(capability, 'storage');
      if (operation === 'kv.get') return store.get(input.key) ?? null;
      if (operation === 'kv.put') {
        store.set(input.key, input.value);
        return input.value;
      }
      throw new Error(`unexpected ${capability}.${operation}`);
    },
  };
}

test('every contributed handler is registered', async () => {
  const host = kvHost();
  const harness = await createWorkerHarness(worker, { host });
  assert.deepEqual(harness.handlers, [
    'digest.read',
    'digest.refresh',
    'digest.show',
    'digest.status',
    'surface.createSession',
  ]);
  await harness.dispose();
});

test('the status handler returns the text and tooltip the status bar reads', async () => {
  const host = kvHost();
  const harness = await createWorkerHarness(worker, { host });

  const before = await harness.invoke('digest.status');
  assert.equal(before.text, '速览未刷新');

  await harness.invoke('digest.refresh');
  const after = await harness.invoke('digest.status');
  assert.match(after.text, /^速览 \d{2}:\d{2}$/);
  assert.equal(after.tooltip, '已刷新 1 次');

  await harness.dispose();
});

test('refreshing counts up rather than resetting', async () => {
  const host = kvHost();
  const harness = await createWorkerHarness(worker, { host });

  await harness.invoke('digest.refresh');
  await harness.invoke('digest.show');
  const digest = await harness.invoke('digest.read');
  assert.equal(digest.refreshCount, 2);

  await harness.dispose();
});
