import { describe, expect, it } from 'vitest';
import {
  BUILTIN_KANBAN_VIEW_IDS,
  BUILTIN_KANBAN_VIEWS,
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
    id: 'plugin:sample/view',
    titleKey: 'e',
    hidesBottomDock: true,
    builtin: false,
  },
];

describe('kanbanViews', () => {
  it('registers independent usage and pulse built-in Kanban pages without standalone workflows entry', () => {
    expect(BUILTIN_KANBAN_VIEW_IDS).toEqual(['builtin:usage', 'builtin:pulse']);
    expect(BUILTIN_KANBAN_VIEWS.map((view) => view.id)).toEqual([
      'builtin:usage',
      'builtin:pulse',
    ]);
  });

  it('migrates legacy kanban views to builtin:usage and migrates builtin:workflows to builtin:pulse', () => {
    expect(migrateKanbanViewId('board')).toBe('builtin:usage');
    expect(migrateKanbanViewId('sessionHub')).toBe('builtin:usage');
    expect(migrateKanbanViewId('sessionHub', 'fixed')).toBe('builtin:usage');
    expect(migrateKanbanViewId('usageDashboard')).toBe('builtin:usage');
    expect(migrateKanbanViewId('builtin:usage')).toBe('builtin:usage');
    expect(migrateKanbanViewId('builtin:pulse')).toBe('builtin:pulse');
    expect(migrateKanbanViewId('builtin:workflows')).toBe('builtin:pulse');
    expect(migrateKanbanViewId('plugin:sample/view')).toBe(
      'plugin:sample/view'
    );
  });

  it('keeps a remembered view when it is still enabled', () => {
    expect(resolveKanbanViewId('builtin:usage', views)).toBe('builtin:usage');
    expect(resolveKanbanViewId('builtin:pulse', views)).toBe('builtin:pulse');
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

  it('hides the unused sessions/canvas twin for the selected board style', () => {
    const fixedViews = kanbanViewsForBoardStyle(views, 'fixed');
    expect(fixedViews.map((view) => view.id)).toEqual([
      'builtin:columns',
      'builtin:sessions',
      'builtin:usage',
      'builtin:pulse',
      'plugin:sample/view',
    ]);

    const canvasViews = kanbanViewsForBoardStyle(views, 'canvas');
    expect(canvasViews.map((view) => view.id)).toEqual([
      'builtin:columns',
      'builtin:canvas',
      'builtin:usage',
      'builtin:pulse',
      'plugin:sample/view',
    ]);
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

  it('hides the execution column on canvas and usage views while keeping it visible on pulse', () => {
    expect(kanbanViewHidesSessionSlot('builtin:columns')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:sessions')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:pulse')).toBe(false);
    expect(kanbanViewHidesSessionSlot('plugin:sample/view')).toBe(false);
    expect(kanbanViewHidesSessionSlot('builtin:canvas')).toBe(true);
    expect(kanbanViewHidesSessionSlot('builtin:usage')).toBe(true);
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
  });

  it('unbinds the hidden kanban execution conversation on canvas and usage while binding it on pulse', () => {
    expect(kanbanBindsExecutionConversation('builtin:canvas', 'kanban')).toBe(
      false
    );
    expect(kanbanBindsExecutionConversation('builtin:usage', 'kanban')).toBe(
      false
    );
    expect(kanbanBindsExecutionConversation('builtin:pulse', 'kanban')).toBe(
      true
    );
    expect(kanbanBindsExecutionConversation('builtin:sessions', 'kanban')).toBe(
      true
    );
    expect(kanbanBindsExecutionConversation('builtin:columns', 'kanban')).toBe(
      true
    );
  });
});
