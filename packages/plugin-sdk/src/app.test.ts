import { describe, expect, it, vi } from 'vitest';

import {
  createPluginContext,
  definePluginApp,
  defineVibeXPlugin,
  isVibeXPluginDefinition,
} from './app.js';
import type { PluginAppSurfaceContext } from './app.js';

describe('definePluginApp', () => {
  it('exports a typed surface definition that Host activate can call with a plugin context', async () => {
    const ready = vi.fn();
    const app = definePluginApp(({ root, bridge, signal }) => {
      expect(root).toBeDefined();
      expect(bridge.pluginId).toBe('dev.vibex.surface');
      expect(signal.aborted).toBe(false);
      bridge.ready();
      ready();
      return () => undefined;
    });

    expect(isVibeXPluginDefinition(app)).toBe(true);
    expect(typeof app.mount).toBe('function');
    expect(typeof app.activate).toBe('function');

    const ctx = createPluginContext({
      pluginId: 'dev.vibex.surface',
      generation: 3,
      hostCall: async () => null,
      invokeWorker: async () => ({ ok: true }),
    });
    const dispose = await app.activate(ctx);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(typeof dispose).toBe('function');
    ctx.dispose();
  });

  it('mounts a surface callback with root, bridge, and signal', async () => {
    const root = {
      replaceChildren: vi.fn(),
      append: vi.fn(),
      appendChild: <T>(node: T) => node,
    };
    const controller = new AbortController();
    const app = definePluginApp((surface: PluginAppSurfaceContext) => {
      surface.root.append('hello');
      surface.bridge.ready();
      return () => surface.root.replaceChildren();
    });

    const dispose = await app.mount({
      root,
      bridge: {
        pluginId: 'dev.vibex.notes',
        generation: 1,
        invoke: async () => null,
        subscribe: () => () => undefined,
        ready: () => undefined,
      },
      signal: controller.signal,
    });
    expect(root.append).toHaveBeenCalledWith('hello');
    dispose?.();
    expect(root.replaceChildren).toHaveBeenCalled();
  });

  it('wraps a VibeXPluginDefinition so either definePluginApp or defineVibeXPlugin can be default-exported', async () => {
    const activate = vi.fn(() => undefined);
    const plugin = defineVibeXPlugin({
      id: 'dev.vibex.wrapped',
      activate,
    });
    const app = definePluginApp(plugin);
    expect(isVibeXPluginDefinition(app)).toBe(true);
    const ctx = createPluginContext({
      pluginId: 'dev.vibex.wrapped',
      hostCall: async () => null,
    });
    await app.activate(ctx);
    expect(activate).toHaveBeenCalledWith(ctx);
  });

  it('accepts an existing VibeXPluginContext without returning undefined', () => {
    const ctx = createPluginContext({
      pluginId: 'dev.vibex.ctx',
      hostCall: async () => null,
    });
    const app = definePluginApp(ctx);
    expect(app).toBeDefined();
    expect(typeof app.activate).toBe('function');
    expect(typeof app.mount).toBe('function');
    expect(isVibeXPluginDefinition(app)).toBe(true);
  });
});
