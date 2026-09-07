import { describe, expect, it } from 'vitest';
import {
  adjacentKanbanViewId,
  kanbanCarouselTranslateX,
  kanbanCarouselWidth,
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
  {
    id: 'plugin:sample/view',
    titleKey: 'e',
    hidesBottomDock: true,
    builtin: false,
  },
];

describe('kanbanViews', () => {
  it('migrates the old three-page plus canvas style model', () => {
    expect(migrateKanbanViewId('board')).toBe('builtin:columns');
    expect(migrateKanbanViewId('sessionHub')).toBe('builtin:sessions');
    expect(migrateKanbanViewId('usageDashboard')).toBe('builtin:usage');
    expect(migrateKanbanViewId('sessionHub', 'canvas')).toBe('builtin:canvas');
  });

  it('keeps a remembered view when it is still enabled', () => {
    expect(resolveKanbanViewId('builtin:usage', views)).toBe('builtin:usage');
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

  it('lets arrows leave the default sessions page and reach a plugin view', () => {
    const fixedViews = kanbanViewsForBoardStyle(views, 'fixed');
    let viewId = 'builtin:sessions';
    viewId = adjacentKanbanViewId(fixedViews, viewId, 1);
    viewId = adjacentKanbanViewId(fixedViews, viewId, 1);
    expect(viewId).toBe('plugin:sample/view');
  });

  it('hides the unused sessions/canvas twin from arrow rotation', () => {
    const fixedViews = kanbanViewsForBoardStyle(views, 'fixed');
    expect(fixedViews.map((view) => view.id)).toEqual([
      'builtin:columns',
      'builtin:sessions',
      'builtin:usage',
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
    expect(adjacentKanbanViewId(views, 'builtin:usage', 1)).toBe(
      'plugin:sample/view'
    );
    expect(adjacentKanbanViewId(views, 'plugin:sample/view', -1)).toBe(
      'builtin:usage'
    );
    expect(adjacentKanbanViewId(views, 'plugin:sample/view', 1)).toBe(
      'plugin:sample/view'
    );
  });

  it('hides the execution column on canvas and usage views', () => {
    expect(kanbanViewHidesSessionSlot('builtin:columns')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:sessions')).toBe(false);
    expect(kanbanViewHidesSessionSlot('plugin:sample/view')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:canvas')).toBe(true);
    expect(kanbanViewHidesSessionSlot('builtin:usage')).toBe(true);
  });

  it('sizes the carousel for N views', () => {
    expect(kanbanCarouselWidth(5)).toBe('500%');
    expect(kanbanCarouselTranslateX(views, 'builtin:sessions')).toBe(
      'translateX(-20%)'
    );
  });
});
