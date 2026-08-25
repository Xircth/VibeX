import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  DEFAULT_KANBAN_SESSION_LIST_VIEW,
  KANBAN_SESSION_LIST_VIEW_KEY,
  getKanbanSessionListView,
  resetKanbanSessionListView,
  setKanbanSessionListView,
  subscribeKanbanSessionListView,
} from './kanbanSessionListView';

describe('kanbanSessionListView', () => {
  beforeEach(() => {
    resetKanbanSessionListView();
    persistFrontendPreference.mockReset();
  });

  it('defaults to status grouping', () => {
    expect(getKanbanSessionListView()).toBe(DEFAULT_KANBAN_SESSION_LIST_VIEW);
    expect(getKanbanSessionListView()).toBe('status');
  });

  it('persists a workspace grouping choice', () => {
    setKanbanSessionListView('workspace');

    expect(localStorage.getItem(KANBAN_SESSION_LIST_VIEW_KEY)).toBe(
      'workspace'
    );
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      KANBAN_SESSION_LIST_VIEW_KEY,
      'workspace'
    );
    expect(getKanbanSessionListView()).toBe('workspace');
  });

  it('ignores invalid persisted values', () => {
    localStorage.setItem(KANBAN_SESSION_LIST_VIEW_KEY, 'columns');

    expect(getKanbanSessionListView()).toBe('status');
  });

  it('notifies subscribers on change', () => {
    let notified = 0;
    const unsubscribe = subscribeKanbanSessionListView(() => {
      notified += 1;
    });

    setKanbanSessionListView('workspace');
    unsubscribe();
    setKanbanSessionListView('status');

    expect(notified).toBe(1);
  });
});
