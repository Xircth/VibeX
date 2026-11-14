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

  it.each(['workspace', 'mixed'] as const)(
    'persists the %s grouping choice',
    (view) => {
      setKanbanSessionListView(view);

      expect(localStorage.getItem(KANBAN_SESSION_LIST_VIEW_KEY)).toBe(view);
      expect(persistFrontendPreference).toHaveBeenCalledWith(
        KANBAN_SESSION_LIST_VIEW_KEY,
        view
      );
      expect(getKanbanSessionListView()).toBe(view);
    }
  );

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
