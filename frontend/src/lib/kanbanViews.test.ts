import { describe, expect, it } from 'vitest';
import {
  BUILTIN_KANBAN_VIEW_IDS,
  BUILTIN_KANBAN_VIEWS,
  adjacentKanbanViewId,
  kanbanCarouselTranslateX,
  kanbanCarouselWidth,
  kanbanBindsExecutionConversation,
  kanbanViewHidesSessionSlot,
  kanbanViewsForBoardStyle,
  migrateKanbanViewId,
  resolveKanbanViewId,
  viewIdForBoardStyleChange,
} from './kanbanViews';

const views = [
  {
    id: 'builtin:columns',
    titleKey: 'a',
    hidesBottomDock: true,
    builtin: true,
  },
  {
    id: 'builtin:sessions',
    titleKey: 'b',
    hidesBottomDock: true,
    builtin: true,
  },
  { id: 'builtin:canvas', titleKey: 'c', hidesBottomDock: true, builtin: true },
  { id: 'builtin:usage', titleKey: 'd', hidesBottomDock: true, builtin: true },
  { id: 'builtin:pulse', titleKey: 'p', hidesBottomDock: true, builtin: true },
  {
    id: 'builtin:workflows',
    titleKey: 'w',
    hidesBottomDock: true,
    builtin: true,
  },
  {
    id: 'plugin:sample/view',
    titleKey: 'e',
    hidesBottomDock: true,
    builtin: false,
  },
];

describe('kanbanViews', () => {
  it('registers independent usage, pulse, and workflows built-in Kanban pages', () => {
    expect(BUILTIN_KANBAN_VIEW_IDS).toEqual([
      'builtin:usage',
      'builtin:pulse',
      'builtin:workflows',
    ]);
    expect(BUILTIN_KANBAN_VIEWS.map((view) => view.id)).toEqual([
      'builtin:usage',
      'builtin:pulse',
      'builtin:workflows',
    ]);
  });

  it('migrates legacy kanban views to builtin:usage while preserving usage, pulse, workflows, and plugin views', () => {
    expect(migrateKanbanViewId('board')).toBe('builtin:usage');
    expect(migrateKanbanViewId('sessionHub')).toBe('builtin:usage');
    expect(migrateKanbanViewId('sessionHub', 'fixed')).toBe('builtin:usage');
    expect(migrateKanbanViewId('usageDashboard')).toBe('builtin:usage');
    expect(migrateKanbanViewId('builtin:usage')).toBe('builtin:usage');
    expect(migrateKanbanViewId('builtin:pulse')).toBe('builtin:pulse');
    expect(migrateKanbanViewId('builtin:workflows')).toBe('builtin:workflows');
    expect(migrateKanbanViewId('plugin:sample/view')).toBe(
      'plugin:sample/view'
    );
  });

  it('keeps a remembered view when it is still enabled', () => {
    expect(resolveKanbanViewId('builtin:usage', views)).toBe('builtin:usage');
    expect(resolveKanbanViewId('builtin:pulse', views)).toBe('builtin:pulse');
    expect(resolveKanbanViewId('builtin:workflows', views)).toBe(
      'builtin:workflows'
    );
    expect(resolveKanbanViewId('plugin:gone/view', views)).toBe(
      'builtin:columns'
    );
    expect(
      resolveKanbanViewId(
        'builtin:canvas',
        kanbanViewsForBoardStyle(views, 'fixed'),
        'fixed'
      )
    ).toBe('builtin:sessions');
  });

  it('lets arrows leave the default sessions page and reach standalone and plugin views', () => {
    const fixedViews = kanbanViewsForBoardStyle(views, 'fixed');
    let viewId = 'builtin:sessions';
    viewId = adjacentKanbanViewId(fixedViews, viewId, 1);
    expect(viewId).toBe('builtin:usage');
    viewId = adjacentKanbanViewId(fixedViews, viewId, 1);
    expect(viewId).toBe('builtin:pulse');
    viewId = adjacentKanbanViewId(fixedViews, viewId, 1);
    expect(viewId).toBe('builtin:workflows');
    viewId = adjacentKanbanViewId(fixedViews, viewId, 1);
    expect(viewId).toBe('plugin:sample/view');
  });

  it('hides the unused sessions/canvas twin from arrow rotation', () => {
    const fixedViews = kanbanViewsForBoardStyle(views, 'fixed');
    expect(fixedViews.map((view) => view.id)).toEqual([
      'builtin:columns',
      'builtin:sessions',
      'builtin:usage',
      'builtin:pulse',
      'builtin:workflows',
      'plugin:sample/view',
    ]);
    expect(adjacentKanbanViewId(fixedViews, 'builtin:sessions', 1)).toBe(
      'builtin:usage'
    );

    const canvasViews = kanbanViewsForBoardStyle(views, 'canvas');
    expect(canvasViews.map((view) => view.id)).toEqual([
      'builtin:columns',
      'builtin:canvas',
      'builtin:usage',
      'builtin:pulse',
      'builtin:workflows',
      'plugin:sample/view',
    ]);
    expect(adjacentKanbanViewId(canvasViews, 'builtin:canvas', 1)).toBe(
      'builtin:usage'
    );
  });

  it('remaps sessions and canvas only when the style preference changes', () => {
    expect(viewIdForBoardStyleChange('fixed', 'builtin:canvas')).toBe(
      'builtin:sessions'
    );
    expect(viewIdForBoardStyleChange('canvas', 'builtin:sessions')).toBe(
      'builtin:canvas'
    );
    expect(viewIdForBoardStyleChange('fixed', 'plugin:sample/view')).toBe(
      'plugin:sample/view'
    );
  });

  it('rotates through plugin views without skipping built-ins', () => {
    expect(adjacentKanbanViewId(views, 'builtin:workflows', 1)).toBe(
      'plugin:sample/view'
    );
    expect(adjacentKanbanViewId(views, 'plugin:sample/view', -1)).toBe(
      'builtin:workflows'
    );
    expect(adjacentKanbanViewId(views, 'plugin:sample/view', 1)).toBe(
      'plugin:sample/view'
    );
  });

  it('hides the execution column on canvas, usage, pulse, and workflows views', () => {
    expect(kanbanViewHidesSessionSlot('builtin:columns')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:sessions')).toBe(false);
    expect(kanbanViewHidesSessionSlot('plugin:sample/view')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:canvas')).toBe(true);
    expect(kanbanViewHidesSessionSlot('builtin:usage')).toBe(true);
    expect(kanbanViewHidesSessionSlot('builtin:pulse')).toBe(true);
    expect(kanbanViewHidesSessionSlot('builtin:workflows')).toBe(true);
  });

  it('keeps the execution conversation bound on workspace even when the kanban slot is hidden', () => {
    expect(
      kanbanBindsExecutionConversation('builtin:canvas', 'workspace')
    ).toBe(true);
    expect(kanbanBindsExecutionConversation('builtin:usage', 'workspace')).toBe(
      true
    );
    expect(kanbanBindsExecutionConversation('builtin:pulse', 'workspace')).toBe(
      true
    );
    expect(
      kanbanBindsExecutionConversation('builtin:workflows', 'workspace')
    ).toBe(true);
  });

  it('unbinds the hidden kanban execution conversation on canvas, usage, pulse, and workflows', () => {
    expect(kanbanBindsExecutionConversation('builtin:canvas', 'kanban')).toBe(
      false
    );
    expect(kanbanBindsExecutionConversation('builtin:usage', 'kanban')).toBe(
      false
    );
    expect(kanbanBindsExecutionConversation('builtin:pulse', 'kanban')).toBe(
      false
    );
    expect(
      kanbanBindsExecutionConversation('builtin:workflows', 'kanban')
    ).toBe(false);
    expect(kanbanBindsExecutionConversation('builtin:sessions', 'kanban')).toBe(
      true
    );
    expect(kanbanBindsExecutionConversation('builtin:columns', 'kanban')).toBe(
      true
    );
  });

  it('sizes the carousel for N views', () => {
    expect(kanbanCarouselWidth(5)).toBe('500%');
    expect(kanbanCarouselTranslateX(views, 'builtin:sessions')).toBe(
      `translateX(-${(1 * 100) / views.length}%)`
    );
  });
});
