import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('./frontendPreferences', () => ({
  persistFrontendPreference,
}));

import {
  DEFAULT_KANBAN_BOARD_STYLE,
  KANBAN_BOARD_STYLE_KEY,
  getKanbanBoardStyle,
  resetKanbanBoardStyle,
  setKanbanBoardStyle,
  subscribeKanbanBoardStyle,
} from './kanbanBoardStyle';

describe('kanbanBoardStyle', () => {
  beforeEach(() => {
    resetKanbanBoardStyle();
    persistFrontendPreference.mockReset();
  });

  it('defaults to the fixed layout', () => {
    expect(getKanbanBoardStyle()).toBe(DEFAULT_KANBAN_BOARD_STYLE);
    expect(getKanbanBoardStyle()).toBe('fixed');
  });

  it('persists the infinite-canvas choice', () => {
    setKanbanBoardStyle('canvas');

    expect(localStorage.getItem(KANBAN_BOARD_STYLE_KEY)).toBe('canvas');
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      KANBAN_BOARD_STYLE_KEY,
      'canvas'
    );
    expect(getKanbanBoardStyle()).toBe('canvas');
  });

  it('ignores invalid persisted values', () => {
    localStorage.setItem(KANBAN_BOARD_STYLE_KEY, 'whiteboard');

    expect(getKanbanBoardStyle()).toBe('fixed');
  });

  it('notifies subscribers on change', () => {
    let notified = 0;
    const unsubscribe = subscribeKanbanBoardStyle(() => {
      notified += 1;
    });

    setKanbanBoardStyle('canvas');
    unsubscribe();
    setKanbanBoardStyle('fixed');

    expect(notified).toBe(1);
  });
});
