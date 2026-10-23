import * as PluginSdk from '@vibex/plugin-sdk';
import * as React from 'react';

(globalThis as Record<string, unknown>).__VIBEX_REACT__ = React;
PluginSdk.bindExternalStoreHook(React.useSyncExternalStore);

declare module '@vibex/plugin-sdk' {
  interface VibeXPluginContext {
    readonly effects: PluginSdk.EffectScope;
  }
}

export type PluginRemoteEnvironment = {
  pluginId: string;
  surfaceId: string;
  slot: string;
  workspaceId?: string | null;
  projectId?: string | null;
  windowLabel?: string | null;
  invoke: (
    handler: string,
    input?: Record<string, unknown> | null
  ) => Promise<unknown>;
};

const activePluginDisposers = new Map<string, () => void>();

export function activatePluginModuleSync(
  pluginId: string,
  module: unknown,
  options?: { callHost?: PluginSdk.HostCallTransport; generation?: number }
): (() => void) | Promise<() => void> {
  deactivatePluginModule(pluginId);

  const rec =
    module && typeof module === 'object'
      ? (module as Record<string, unknown>)
      : {};
  const candidate = PluginSdk.isVibeXPluginDefinition(rec.default)
    ? rec.default
    : PluginSdk.isVibeXPluginDefinition(module)
      ? module
      : null;
  const activateFn = candidate
    ? candidate.activate.bind(candidate)
    : typeof rec.activate === 'function'
      ? (rec.activate as (
          ctx: PluginSdk.VibeXPluginContext
        ) => void | (() => void) | Promise<void | (() => void)>)
      : typeof rec.default === 'function'
        ? (rec.default as (
            ctx: PluginSdk.VibeXPluginContext
          ) => void | (() => void) | Promise<void | (() => void)>)
        : typeof module === 'function'
          ? (module as (
              ctx: PluginSdk.VibeXPluginContext
            ) => void | (() => void) | Promise<void | (() => void)>)
          : null;

  if (!activateFn) {
    throw new Error('plugin_activate_export_missing');
  }

  const ctx = PluginSdk.createPluginContext({
    pluginId,
    generation: options?.generation,
    callHost: options?.callHost,
  });
  if (!('effects' in (ctx as unknown as Record<string, unknown>))) {
    Object.defineProperty(ctx, 'effects', {
      get: () => ctx.scope,
      enumerable: true,
      configurable: true,
    });
  }
  let returnedDisposer: void | (() => void);
  const dispose = () => {
    activePluginDisposers.delete(pluginId);
    try {
      if (typeof returnedDisposer === 'function') {
        returnedDisposer();
      }
    } finally {
      try {
        candidate?.deactivate?.();
      } finally {
        ctx.dispose();
      }
    }
  };
  activePluginDisposers.set(pluginId, dispose);

  try {
    const maybePromise = activateFn(ctx);
    if (
      maybePromise &&
      typeof (maybePromise as Promise<unknown>).then === 'function'
    ) {
      return (maybePromise as Promise<void | (() => void)>).then(
        (resolvedDisposer) => {
          returnedDisposer = resolvedDisposer;
          return dispose;
        },
        (error) => {
          activePluginDisposers.delete(pluginId);
          ctx.dispose();
          throw error;
        }
      );
    }
    returnedDisposer = maybePromise as void | (() => void);
  } catch (error) {
    activePluginDisposers.delete(pluginId);
    ctx.dispose();
    throw error;
  }

  return dispose;
}

export async function activatePluginModule(
  pluginId: string,
  module: unknown,
  options?: { callHost?: PluginSdk.HostCallTransport; generation?: number }
): Promise<() => void> {
  return await activatePluginModuleSync(pluginId, module, options);
}

export function deactivatePluginModule(pluginId: string): void {
  const dispose = activePluginDisposers.get(pluginId);
  if (dispose) {
    dispose();
  } else {
    PluginSdk.disposePluginRegistrations(pluginId);
    PluginSdk.globalServices.disposePlugin(pluginId);
  }
}

export function isPluginModuleActive(pluginId: string): boolean {
  return activePluginDisposers.has(pluginId);
}
