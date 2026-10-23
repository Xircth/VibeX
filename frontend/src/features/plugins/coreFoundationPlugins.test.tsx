import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  CORE_FOUNDATION_GLYPHS,
  CoreFoundationPluginIcon,
  PluginProductIcon,
} from '@/pages/plugins/OfficialPluginIcon';
import {
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS,
  CORE_PLUGIN_PLANES,
  ensureCoreFoundationPluginsBootstrapped,
  getCoreFoundationInventory,
  type CoreFoundationArtworkKey,
} from './coreFoundationPlugins';

describe('CoreFoundationPlugins (DSH-aligned decomposition)', () => {
  it('decomposes VibeX into 22 first-class plugins across 4 planes', () => {
    expect(CORE_PLUGIN_PLANES.map((plane) => plane.id)).toEqual([
      'webui',
      'agent',
      'execution',
      'boot',
    ]);
    expect(CORE_FOUNDATION_PLUGIN_DESCRIPTORS).toHaveLength(22);

    const ids = new Set(CORE_FOUNDATION_PLUGIN_DESCRIPTORS.map((item) => item.id));
    expect(ids.size).toBe(22);
    expect(ids.has('vibex.core.plugin-manager')).toBe(true);
    expect(ids.has('vibex.core.agent-runtime')).toBe(true);
    expect(ids.has('vibex.core.skills')).toBe(true);
    expect(ids.has('vibex.core.shell')).toBe(true);
    expect(ids.has('vibex.webui.layout')).toBe(true);
    expect(ids.has('vibex.webui.conversation')).toBe(true);
    expect(ids.has('vibex.webui.kanban')).toBe(true);
  });

  it('activates all 22 core foundation plugins and satisfies all dependency injections', () => {
    ensureCoreFoundationPluginsBootstrapped();
    const inventory = getCoreFoundationInventory();
    expect(inventory).toHaveLength(22);

    for (const item of inventory) {
      expect(
        item.active,
        `${item.descriptor.id} should be active`
      ).toBe(true);
      expect(
        item.dependenciesSatisfied,
        `${item.descriptor.id} dependencies should be satisfied`
      ).toBe(true);
      expect(item.descriptor.parts.length).toBeGreaterThan(0);
    }
  });

  it('provides a bespoke 36x36 SVG icon artwork for every core foundation plugin', () => {
    for (const descriptor of CORE_FOUNDATION_PLUGIN_DESCRIPTORS) {
      const key = descriptor.artworkKey as CoreFoundationArtworkKey;
      expect(
        CORE_FOUNDATION_GLYPHS[key],
        `${descriptor.id} (${key}) must have SVG artwork`
      ).toBeDefined();

      const { container, unmount } = render(
        <CoreFoundationPluginIcon artworkKey={key} pluginId={descriptor.id} />
      );
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();

      const byPluginId = render(<PluginProductIcon pluginId={descriptor.id} />);
      expect(byPluginId.container.querySelector('svg')).not.toBeNull();
      byPluginId.unmount();
    }
  });
});
