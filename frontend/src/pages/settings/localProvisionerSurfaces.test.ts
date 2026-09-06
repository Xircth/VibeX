import { describe, expect, it } from 'vitest';

import { localProvisionerSurfaces } from './localProvisionerSurfaces';
import type {
  PluginContributionCatalog,
  PluginControlCatalog,
  PluginControlItem,
} from '@/lib/api/plugins';

function plugin(id: string, name: string): PluginControlItem {
  return {
    id,
    name,
    version: '1.0.0',
    description: null,
    enabled: true,
    builtin: true,
    sourceKind: 'vibex',
    sourcePath: `/plugins/${id}`,
    formats: ['vibex'],
    skills: [],
    runtimes: [],
    warnings: [],
  };
}

describe('localProvisionerSurfaces', () => {
  it('keeps provisioner panels by contribution kind, not plugin identity', () => {
    const catalog: PluginControlCatalog = {
      plugins: [
        plugin('acme.tunnel', 'Acme Tunnel'),
        plugin('other', 'Other'),
      ],
      runtimes: [],
    };
    const contributions: PluginContributionCatalog = {
      generation: 1,
      items: [
        {
          pluginId: 'acme.tunnel',
          id: 'tunnel',
          kind: 'remote_provisioner',
          label: 'Tunnel',
          generation: 1,
          metadata: { provisionKind: 'wireguard' },
        },
        {
          pluginId: 'acme.tunnel',
          id: 'connect-panel',
          kind: 'app_surface',
          label: 'Acme Tunnel',
          generation: 1,
          metadata: {
            slot: 'plugin.detail.panel',
            handler: 'surface.createSession',
            appEntrypoint: 'app',
            allowedMethods: ['session.start'],
            minHeight: 640,
          },
        },
      ],
    };

    const panels = localProvisionerSurfaces(catalog, contributions);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.plugin.id).toBe('acme.tunnel');
    expect(panels[0]?.label).toBe('Tunnel');
    expect(panels[0]?.kind).toBe('wireguard');
    expect(panels[0]?.surfaces[0]?.surfaceId).toBe('connect-panel');
  });
});
