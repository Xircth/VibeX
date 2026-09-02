import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('./frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  DEFAULT_KANBAN_CANVAS_LIST_VISIBLE,
  KANBAN_CANVAS_LIST_VISIBLE_KEY,
  getKanbanCanvasListVisible,
  resetKanbanCanvasListVisible,
  setKanbanCanvasListVisible,
  subscribeKanbanCanvasListVisible,
  toggleKanbanCanvasListVisible,
} from './kanbanCanvasListVisible';

describe('kanbanCanvasListVisible', () => {
  beforeEach(() => {
    resetKanbanCanvasListVisible();
    persistFrontendPreference.mockReset();
  });

  it('defaults to visible', () => {
    expect(getKanbanCanvasListVisible()).toBe(
      DEFAULT_KANBAN_CANVAS_LIST_VISIBLE
    );
    expect(getKanbanCanvasListVisible()).toBe(true);
  });

  it('persists a hidden choice', () => {
    setKanbanCanvasListVisible(false);

    expect(localStorage.getItem(KANBAN_CANVAS_LIST_VISIBLE_KEY)).toBe('false');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      KANBAN_CANVAS_LIST_VISIBLE_KEY,
      false
    );
    expect(getKanbanCanvasListVisible()).toBe(false);
  });

  it('toggles visibility', () => {
    toggleKanbanCanvasListVisible();
    expect(getKanbanCanvasListVisible()).toBe(false);
    toggleKanbanCanvasListVisible();
    expect(getKanbanCanvasListVisible()).toBe(true);
  });

  it('notifies subscribers on change', () => {
    let notified = 0;
    const unsubscribe = subscribeKanbanCanvasListVisible(() => {
      notified += 1;
    });

    setKanbanCanvasListVisible(false);
    unsubscribe();
    setKanbanCanvasListVisible(true);

    expect(notified).toBe(1);
  });
});
