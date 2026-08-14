import { describe, expect, it, vi } from 'vitest';

import { createWorkerHarness } from './testing.js';
import { definePluginWorker, PluginSdkError } from './worker.js';

describe('VibeX plugin worker SDK', () => {
  it('registers typed handlers and disposes them in reverse order', async () => {
    const disposal: string[] = [];
    const worker = definePluginWorker((plugin) => {
      plugin.handle('document.preview', (input) => ({ received: input }));
      plugin.handle('surface.createSession', () => ({ ready: true }));
      plugin.onDispose(() => {
        disposal.push('first');
      });
      plugin.onDispose(() => {
        disposal.push('second');
      });
    });
    const harness = await createWorkerHarness(worker);

    await expect(
      harness.invoke('document.preview', { path: 'example.docx' })
    ).resolves.toEqual({ received: { path: 'example.docx' } });
    expect(harness.handlers).toEqual([
      'document.preview',
      'surface.createSession',
    ]);

    await harness.dispose();
    expect(disposal).toEqual(['second', 'first']);
  });

  it('rejects duplicate handlers before activation becomes visible', async () => {
    const handler = vi.fn(() => null);
    const worker = definePluginWorker((plugin) => {
      plugin.handle('document.preview', handler);
      plugin.handle('document.preview', handler);
    });

    await expect(createWorkerHarness(worker)).rejects.toEqual(
      expect.objectContaining<Partial<PluginSdkError>>({
        code: 'handler_duplicate',
      })
    );
  });
});
