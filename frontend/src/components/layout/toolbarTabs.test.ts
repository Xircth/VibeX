import { describe, expect, it } from 'vitest';

import { COLLABORATION_WORKSPACE_TAB } from '@/lib/hostSurfaceIds';
import { collectPluginToolbarTabs } from './toolbarTabs';

const BUILTIN = ['kanban', 'workspace', COLLABORATION_WORKSPACE_TAB];

// Mirrors the Toolbar: built-in tabs + plugin tabs.
function toolbarKeys(
  collaborationEnabled: boolean,
  sdkViews: Parameters<typeof collectPluginToolbarTabs>[2],
  pluginTabs: Parameters<typeof collectPluginToolbarTabs>[1] = []
) {
  return [
    'workspace',
    ...(collaborationEnabled ? [COLLABORATION_WORKSPACE_TAB] : []),
    ...collectPluginToolbarTabs(BUILTIN, pluginTabs, sdkViews).map(
      (t) => t.key
    ),
  ];
}

const delegationView = {
  id: COLLABORATION_WORKSPACE_TAB,
  pluginId: 'vibex.core.delegation',
  kind: 'tab',
  title: '协作',
};

describe('collectPluginToolbarTabs', () => {
  it('drops a plugin tab view whose id matches a built-in tab', () => {
    expect(collectPluginToolbarTabs(BUILTIN, [], [delegationView])).toEqual([]);
  });

  it('drops built-in collisions for any plugin id and id form', () => {
    const items = collectPluginToolbarTabs(
      BUILTIN,
      [{ pluginId: 'acme.x', id: 'workspace', label: 'W' }],
      [
        { ...delegationView, pluginId: 'acme.y', id: 'acme.y:collaboration' },
        {
          id: 'plugin:acme.z/kanban',
          pluginId: 'acme.z',
          kind: 'tab',
          title: 'K',
        },
      ]
    );
    expect(items).toEqual([]);
  });

  it('keeps unrelated plugin tabs', () => {
    const items = collectPluginToolbarTabs(
      BUILTIN,
      [],
      [{ id: 'board', pluginId: 'acme', kind: 'tab', title: 'Board' }]
    );
    expect(items.map((i) => i.key)).toEqual(['plugin:acme/board']);
  });

  it.each([true, false])(
    'shows at most one collaboration entry (multi-agent enabled=%s)',
    (enabled) => {
      const keys = toolbarKeys(enabled, [delegationView]);
      const collab = keys.filter((k) => k.includes('collaboration'));
      expect(collab).toEqual(enabled ? [COLLABORATION_WORKSPACE_TAB] : []);
    }
  );
});
