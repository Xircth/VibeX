import { createInstance } from '@module-federation/runtime';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';

export type PluginRemoteRef = {
  name: string;
  entry: string;
  module: string;
};

export type PluginRemoteEnvironment = {
  pluginId: string;
  surfaceId: string;
  slot: string;
  workspaceId?: string | null;
  projectId?: string | null;
  invoke: (
    handler: string,
    input?: Record<string, unknown> | null
  ) => Promise<unknown>;
};

type RemoteModule = {
  default?: unknown;
  mount?: (
    root: HTMLElement,
    environment?: PluginRemoteEnvironment
  ) => void | (() => void);
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

const LOAD_REMOTE_TIMEOUT_MS = 8_000;

/** Live mounts of each remote name. Unregister only after the last one goes. */
const remoteUsers = new Map<string, number>();

function releaseRemote(name: string): void {
  const next = (remoteUsers.get(name) ?? 0) - 1;
  if (next > 0) {
    remoteUsers.set(name, next);
    return;
  }
  remoteUsers.delete(name);
  const runtime = host;
  if (!runtime || !name) return;
  const unregister = (
    runtime as FederationRuntime & {
      unregisterRemotes?: (
        remotes: string[],
        options?: { force?: boolean }
      ) => void | Promise<void>;
    }
  ).unregisterRemotes;
  if (typeof unregister === 'function') {
    void unregister.call(runtime, [name], { force: true });
  }
}

export function unloadPluginRemote(name: string): void {
  if (!name) return;
  releaseRemote(name);
}

export async function loadPluginRemote(
  remote: PluginRemoteRef
): Promise<RemoteModule> {
  remoteUsers.set(remote.name, (remoteUsers.get(remote.name) ?? 0) + 1);
  const runtime = federationHost();
  await runtime.registerRemotes(
    [{ name: remote.name, entry: remote.entry, type: 'module' }],
    { force: true }
  );
  return await loadRegisteredRemote(runtime, remote);
}

async function loadRegisteredRemote(
  runtime: FederationRuntime,
  remote: PluginRemoteRef
): Promise<RemoteModule> {
  const loaded = await Promise.race([
    runtime.loadRemote<RemoteModule>(
      `${remote.name}/${remote.module.replace(/^\.\//, '')}`
    ),
    new Promise<RemoteModule>((_, reject) => {
      globalThis.setTimeout(
        () => reject(new Error('plugin_remote_timeout')),
        LOAD_REMOTE_TIMEOUT_MS
      );
    }),
  ]);
  if (loaded) return loaded;
  throw new Error('plugin_remote_export_missing');
}

export function mountRemoteModule(
  module: RemoteModule,
  root: HTMLElement,
  environment?: PluginRemoteEnvironment
): (() => void) | void {
  if (typeof module.mount === 'function') {
    return module.mount(root, environment);
  }
  const View = module.default;
  if (typeof View === 'function') {
    const reactRoot = createRoot(root);
    reactRoot.render(
      React.createElement(
        View as React.ComponentType<{ environment?: PluginRemoteEnvironment }>,
        { environment }
      )
    );
    return () => reactRoot.unmount();
  }
  throw new Error('plugin_remote_export_missing');
}
