import { describe, expect, it } from 'vitest';

import { definePluginApp } from './app.js';
import { createAppHarness, createGenerationHarness } from './testing.js';
import { definePluginWorker } from './worker.js';

describe('plugin testing harnesses', () => {
  it('keeps the published generation active when a candidate fails', async () => {
    const first = definePluginWorker((registrar) => {
      registrar.handle('value', () => 'published');
    });
    const broken = definePluginWorker((registrar) => {
      registrar.handle('other', () => 'candidate');
    });
    const harness = await createGenerationHarness(first, {
      requiredHandlers: ['value'],
    });

    await expect(harness.activateCandidate(broken)).rejects.toMatchObject({
      code: 'required_handler_missing',
    });
    expect(harness.generation).toBe(1);
    await expect(harness.invoke('value', null)).resolves.toBe('published');

    await harness.dispose();
  });

  it('routes App bridge calls and revokes the surface token', async () => {
    let changed: unknown;
    const app = definePluginApp(({ bridge }) => {
      bridge.subscribe('changed', (payload) => {
        changed = payload;
      });
      bridge.ready();
    });
    const harness = await createAppHarness(app, {
      root: {} as HTMLElement,
      invoke: async (handler, input) => ({ handler, input }),
    });

    expect(harness.ready).toBe(true);
    await expect(harness.bridge.invoke('hello', { value: 1 })).resolves.toEqual(
      {
        handler: 'hello',
        input: { value: 1 },
      }
    );
    harness.emit('changed', { revision: 2 });
    expect(changed).toEqual({ revision: 2 });

    harness.revoke();
    await expect(harness.bridge.invoke('hello')).rejects.toMatchObject({
      code: 'surface_revoked',
    });
    expect(harness.signal.aborted).toBe(true);
  });

  it('provides a typed artifact editor bridge to App tests', async () => {
    let opened: unknown;
    const app = definePluginApp(async ({ bridge }) => {
      opened = await bridge.artifact?.readText();
    });
    const harness = await createAppHarness(app, {
      root: {} as HTMLElement,
      artifact: {
        name: 'architecture.drawio',
        content: '<mxfile />',
        revision: 'sha256:first',
      },
    });

    expect(opened).toEqual({
      name: 'architecture.drawio',
      content: '<mxfile />',
      revision: 'sha256:first',
    });
    await expect(
      harness.bridge.artifact?.writeText(
        '<mxfile><diagram /></mxfile>',
        'sha256:first'
      )
    ).resolves.toEqual({ revision: expect.stringMatching(/^sha256:/) });
  });
});
