import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import type { PluginControlItem } from './plugins';
import {
  appSurfaceDescriptors,
  createBackendAppSurfaceTransport,
} from './appSurfaceTransport';

const plugin = {
  id: 'acme.dashboard',
  name: 'Dashboard',
  version: '1.0.0',
  description: null,
  enabled: true,
  builtin: false,
  sourceKind: 'snapshot',
  sourcePath: '/plugins/acme.dashboard',
  formats: ['vibex'],
  skills: [],
  runtimes: [],
  warnings: [],
} satisfies PluginControlItem;

describe('App surface backend transport', () => {
  it('opens a generation-bound session through the injected BackendTransport', async () => {
    const call = vi.fn().mockResolvedValue({
      html: '<main>Dashboard</main>',
      token: '0123456789abcdef0123456789abcdef',
    });
    const backend = {
      environment: 'web',
      call,
    } satisfies BackendTransport;
    const transport = createBackendAppSurfaceTransport(backend);

    await expect(
      transport.load({
        pluginId: plugin.id,
        surfaceId: 'dashboard',
        generation: 2,
        token: 'token',
      })
    ).resolves.toEqual({
      html: '<main>Dashboard</main>',
      token: '0123456789abcdef0123456789abcdef',
    });
    expect(call).toHaveBeenCalledWith('plugin_surface_open', {
      pluginId: plugin.id,
      surfaceId: 'dashboard',
      generation: 2,
      token: 'token',
    });
  });

  it('rejects a non-text broker document', async () => {
    const call = vi.fn().mockResolvedValue({ html: { forged: true } });
    const transport = createBackendAppSurfaceTransport({
      environment: 'desktop',
      call,
    });

    await expect(
      transport.load({
        pluginId: plugin.id,
        surfaceId: 'dashboard',
        generation: 2,
        token: 'token',
      })
    ).rejects.toThrow(/invalid document/i);
  });

  it('normalizes only typed app_surface contribution metadata', () => {
    expect(
      appSurfaceDescriptors(plugin, [
        {
          pluginId: plugin.id,
          id: 'dashboard',
          kind: 'app_surface',
          label: 'Dashboard',
          generation: 8,
          metadata: {
            slot: 'plugin.detail.panel',
            appEntrypoint: 'app',
            route: '/dashboard',
            handler: 'surface.createSession',
            allowedMethods: ['app.navigation.open', 'app.navigation.open'],
            minHeight: 12_000,
          },
        },
        {
          pluginId: plugin.id,
          id: 'not-a-surface',
          kind: 'command',
          label: 'Command',
          generation: 8,
          metadata: {},
        },
      ])
    ).toEqual([
      expect.objectContaining({
        pluginId: plugin.id,
        surfaceId: 'dashboard',
        generation: 8,
        initialRoute: '/dashboard',
        allowedMethods: ['app.navigation.open'],
        minHeight: 900,
      }),
    ]);
  });
});
