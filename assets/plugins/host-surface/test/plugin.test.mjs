import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import worker from '../runtime/worker.mjs';

test('the sample worker exposes the App session handler', async () => {
  const harness = await createWorkerHarness(worker);
  assert.deepEqual(harness.handlers, ['surface.createSession']);
  const session = await harness.invoke('surface.createSession');
  assert.equal(session.ready, true);
  await harness.dispose();
});
