import { describe, expect, it } from 'vitest';
import { getComposerTodoListState } from './sessionComposerTodos';

describe('session composer todo helpers', () => {
  it('derives list count and empty-state visibility', () => {
    expect(getComposerTodoListState(0)).toEqual({
      isEmpty: true,
      showCount: false,
    });

    expect(getComposerTodoListState(2)).toEqual({
      isEmpty: false,
      showCount: true,
    });
  });
});
