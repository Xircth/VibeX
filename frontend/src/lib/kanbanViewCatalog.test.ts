import { kanbanViewRegistry } from '@vibex/plugin-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureCoreFoundationPluginsBootstrapped,
  getCoreFoundationPluginSource,
} from '@/features/plugins/coreFoundationPlugins';
import {
  loadPluginRuntime,
  unloadPluginRuntime,
} from '@/features/plugins/PluginRuntimeLoader';
import {
  isKanbanViewContribution,
  kanbanViewsFromCatalog,
} from './kanbanViewCatalog';

describe('kanbanViewCatalog', () => {
  beforeEach(() => {
    kanbanViewRegistry.clear();
    unloadPluginRuntime('vibex.webui.kanban');
    ensureCoreFoundationPluginsBootstrapped({
      force: true,
      onlyIds: ['vibex.webui.kanban'],
    });
  });

  it('accepts the dedicated kind and the synthesized surface slot', () => {
    expect(
      isKanbanViewContribution({
        pluginId: 'vibex.host-surface',
        id: 'sample-view',
        kind: 'kanban_view',
        label: '示例视图',
        generation: 1,
        metadata: {},
      })
    ).toBe(true);
    expect(
      isKanbanViewContribution({
        pluginId: 'vibex.host-surface',
        id: 'sample-view',
        kind: 'app_surface',
        label: '示例视图',
        generation: 1,
        metadata: { slot: 'app.kanban.view' },
      })
    ).toBe(true);
    expect(
      isKanbanViewContribution({
        pluginId: 'vibex.host-surface',
        id: 'sample-tab',
        kind: 'app_tab',
        label: '示例页',
        generation: 1,
        metadata: {},
      })
    ).toBe(false);
  });

  it('appends one plugin view after the built-in usage view registered by vibex.webui.kanban', () => {
    const views = kanbanViewsFromCatalog([
      {
        pluginId: 'vibex.host-surface',
        id: 'sample-view',
        kind: 'kanban_view',
        label: '示例视图',
        generation: 4,
        metadata: { hidesBottomDock: true },
      },
      {
        pluginId: 'vibex.host-surface',
        id: 'sample-view',
        kind: 'app_surface',
        label: '示例视图',
        generation: 4,
        metadata: { slot: 'app.kanban.view' },
      },
    ]);
    expect(views).toHaveLength(2);
    expect(views.slice(0, 1).map((v) => v.id)).toEqual(['builtin:usage']);
    expect(views[1]).toMatchObject({
      id: 'plugin:vibex.host-surface/sample-view',
      titleKey: '示例视图',
      builtin: false,
    });
  });

  it('uses kanbanViewRegistry as the single source of truth and removes built-in views when vibex.webui.kanban is unloaded', async () => {
    expect(kanbanViewsFromCatalog([]).map((v) => v.id)).toEqual([
      'builtin:usage',
    ]);

    unloadPluginRuntime('vibex.webui.kanban');
    expect(kanbanViewRegistry.getAll()).toHaveLength(0);
    expect(kanbanViewsFromCatalog([])).toEqual([]);

    const pluginOnly = kanbanViewsFromCatalog([
      {
        pluginId: 'vibex.host-surface',
        id: 'sample-view',
        kind: 'kanban_view',
        label: '示例视图',
        generation: 1,
        metadata: {},
      },
    ]);
    expect(pluginOnly).toHaveLength(1);
    expect(pluginOnly[0]?.id).toBe('plugin:vibex.host-surface/sample-view');

    await loadPluginRuntime(
      'vibex.webui.kanban',
      getCoreFoundationPluginSource('vibex.webui.kanban')
    );
    expect(kanbanViewsFromCatalog([]).map((v) => v.id)).toEqual([
      'builtin:usage',
    ]);
  });
});
