import { createInstance } from '@module-federation/runtime';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';

export type PluginRemoteRef = {
  name: string;
  entry: string;
  module: string;
};

type RemoteModule = {
  default?: unknown;
  mount?: (root: HTMLElement) => void | (() => void);
};

type FederationRuntime = ReturnType<typeof createInstance>;

let host: FederationRuntime | null = null;

function federationHost(): FederationRuntime {
  if (host) return host;
  host = createInstance({
    name: 'vibex_host',
    remotes: [],
    shared: {
      react: {
        version: '19.2.8',
        scope: 'default',
        lib: () => React,
        shareConfig: { singleton: true, requiredVersion: false },
      },
      'react-dom': {
        version: '19.2.8',
        scope: 'default',
        lib: () => ReactDOM,
        shareConfig: { singleton: true, requiredVersion: false },
      },
    },
  });
  return host;
}

export function parseRemoteRef(value: unknown): PluginRemoteRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const remote = value as Record<string, unknown>;
  if (typeof remote.name !== 'string' || !remote.name) return null;
  if (typeof remote.entry !== 'string' || !remote.entry) return null;
  return {
    name: remote.name,
    entry: remote.entry,
    module:
      typeof remote.module === 'string' && remote.module
        ? remote.module
        : './view',
  };
}

export function isHttpRemoteEntry(entry: string): boolean {
  return /^https?:\/\//.test(entry);
}

export async function loadPluginRemote(remote: PluginRemoteRef): Promise<RemoteModule> {
  const runtime = federationHost();
  await runtime.registerRemotes(
    [{ name: remote.name, entry: remote.entry, type: 'module' }],
    { force: true }
  );
  const loaded = await runtime.loadRemote<RemoteModule>(
    `${remote.name}/${remote.module.replace(/^\.\//, '')}`
  );
  if (loaded) return loaded;
  const fallback = await import(/* @vite-ignore */ remote.entry);
  return fallback as RemoteModule;
}

export function mountRemoteModule(
  module: RemoteModule,
  root: HTMLElement
): (() => void) | void {
  if (typeof module.mount === 'function') {
    return module.mount(root);
  }
  const View = module.default;
  if (typeof View === 'function') {
    const reactRoot = createRoot(root);
    reactRoot.render(React.createElement(View as React.ComponentType));
    return () => reactRoot.unmount();
  }
  throw new Error('plugin_remote_export_missing');
}
