import { describe, expect, it, vi } from 'vitest';

import { createWorkerHarness } from './testing.js';
import {
  activatePluginWorker,
  createWorkerHost,
  definePluginWorker,
  PluginSdkError,
} from './worker.js';

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
    expect(worker.apiVersion).toBe('2.0');
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

  it('shares services and waterfall hooks across workers and revokes them on dispose', async () => {
    const providerWorker = definePluginWorker((plugin, env) => {
      env.services.provide('calc.multiply', {
        multiply: (a: number, b: number) => a * b,
      });
      env.services.intercept(
        'text.transform',
        (value: string) => `${value}::provider`,
        10
      );
      plugin.handle('provider.ready', () => true);
    });

    const consumerWorker = definePluginWorker((plugin, env) => {
      plugin.handle(
        'consumer.run',
        async (input: { a: number; b: number; text: string }) => {
          const svc = env.services.inject<{
            multiply: (a: number, b: number) => number;
          }>('calc.multiply');
          const product = svc ? svc.multiply(input.a, input.b) : null;
          const text = await env.services.runWaterfall(
            'text.transform',
            input.text,
            async (payload) => payload
          );
          return {
            hasService: env.services.has('calc.multiply'),
            product,
            text,
          };
        }
      );
    });

    const providerHarness = await createWorkerHarness(providerWorker, {
      pluginId: 'dev.vibex.provider',
    });
    const consumerHarness = await createWorkerHarness(consumerWorker, {
      pluginId: 'dev.vibex.consumer',
    });

    await expect(
      consumerHarness.invoke('consumer.run', { a: 6, b: 7, text: 'hello' })
    ).resolves.toEqual({
      hasService: true,
      product: 42,
      text: 'hello::provider',
    });

    await providerHarness.dispose();

    await expect(
      consumerHarness.invoke('consumer.run', { a: 6, b: 7, text: 'hello' })
    ).resolves.toEqual({
      hasService: false,
      product: null,
      text: 'hello',
    });

    await consumerHarness.dispose();
  });

  it('activates workers that declare apiVersion 1.0 or 2.0', async () => {
    const v1 = definePluginWorker({
      apiVersion: '1.0',
      setup(plugin) {
        plugin.handle('echo.v1', (input) => input);
      },
    });
    const v2 = definePluginWorker({
      apiVersion: '2.0',
      setup(plugin) {
        plugin.handle('echo.v2', (input) => input);
      },
    });
    const v1Harness = await createWorkerHarness(v1);
    const v2Harness = await createWorkerHost(v2, {
      context: {
        pluginId: 'dev.vibex.v2',
        pluginVersion: '0.0.0-test',
        generation: 1,
        packageClass: 'full-trust',
        grantedCapabilities: ['*'],
      },
      host: { async call() { return null; } },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await expect(v1Harness.invoke('echo.v1', { n: 1 })).resolves.toEqual({ n: 1 });
    await expect(v2Harness.invoke('echo.v2', { n: 2 })).resolves.toEqual({ n: 2 });
    await v1Harness.dispose();
    await v2Harness.dispose();
  });

  it('rejects unsupported worker api versions', async () => {
    await expect(
      activatePluginWorker(
        {
          apiVersion: '3.0' as '1.0',
          setup() {},
        },
        {
          context: {
            pluginId: 'dev.vibex.bad',
            pluginVersion: '0.0.0-test',
            generation: 1,
            packageClass: 'full-trust',
            grantedCapabilities: ['*'],
          },
          host: { async call() { return null; } },
          log: { debug() {}, info() {}, warn() {}, error() {} },
        }
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<PluginSdkError>>({
        code: 'sdk_incompatible',
      })
    );
  });
});
