import { describe, expect, it } from 'vitest';

import {
  isHttpRemoteEntry,
  loadPluginRemote,
  parseRemoteRef,
  unloadPluginRemote,
} from './pluginFederation';

describe('plugin federation remotes', () => {
  it('accepts a named HTTP remote and defaults the module', () => {
    expect(
      parseRemoteRef({
        name: 'host_surface',
        entry: 'http://127.0.0.1:9/remoteEntry.js',
      })
    ).toEqual({
      name: 'host_surface',
      entry: 'http://127.0.0.1:9/remoteEntry.js',
      module: './view',
    });
    expect(isHttpRemoteEntry('http://127.0.0.1:9/remoteEntry.js')).toBe(true);
    expect(isHttpRemoteEntry('dist/remoteEntry.js')).toBe(false);
  });

  it('rejects an incomplete remote', () => {
    expect(parseRemoteRef({ name: 'host_surface' })).toBeNull();
    expect(parseRemoteRef(null)).toBeNull();
  });

  it('unloads a remote without requiring a prior load', () => {
    expect(() => unloadPluginRemote('host_surface')).not.toThrow();
  });

  it('unregisters after a failed remote load without throwing', async () => {
    await expect(
      loadPluginRemote({
        name: 'host_surface',
        entry: 'http://127.0.0.1:9/remoteEntry.js',
        module: './view',
      })
    ).rejects.toThrow('plugin_remote_export_missing');
    expect(() => unloadPluginRemote('host_surface')).not.toThrow();
  });
});
