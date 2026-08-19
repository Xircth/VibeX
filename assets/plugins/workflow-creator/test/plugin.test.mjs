import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';
import definition from '../runtime/worker.mjs';

test('registers the Workflow artifact editor session handler', async () => {
  const worker = await createWorkerHarness(definition);
  assert.deepEqual(worker.handlers, ['surface.createSession']);
  assert.deepEqual(await worker.invoke('surface.createSession', { artifactName: 'release.vibex-workflow.json' }), {
    ready: true,
    artifactName: 'release.vibex-workflow.json',
  });
  await worker.dispose();
});
