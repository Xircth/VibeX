import { describe, expect, it } from 'vitest';

import { defineVibeXPlugin } from './app.js';
import {
  createGenerationHarness,
  createPluginTestHarness,
} from './testing.js';
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

  it('activates a v2 plugin definition and cleans up its registrations on dispose', async () => {
    const plugin = defineVibeXPlugin({
      id: 'acme.harness-test',
      async activate(ctx) {
        ctx.ui.registerCommand({
          id: 'acme.hello',
          title: 'Hello from Harness',
          handler: () => undefined,
        });
        await ctx.storage.kv.set('greeting', 'hello');
      },
    });
    const harness = createPluginTestHarness(plugin);
    await harness.activate();

    expect(harness.getCommands()).toHaveLength(1);
    await expect(harness.ctx.storage.kv.get('greeting')).resolves.toBe('hello');

    await harness.dispose();
    expect(harness.getCommands()).toHaveLength(0);
  });
});
