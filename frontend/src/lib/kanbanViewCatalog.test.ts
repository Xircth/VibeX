import { describe, expect, it } from 'vitest';
import {
  isKanbanViewContribution,
  kanbanViewsFromCatalog,
} from './kanbanViewCatalog';

describe('kanbanViewCatalog', () => {
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

  it('appends one plugin view after the four built-ins', () => {
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
    expect(views).toHaveLength(5);
    expect(views[4]).toMatchObject({
      id: 'plugin:vibex.host-surface/sample-view',
      titleKey: '示例视图',
      builtin: false,
    });
  });
});
