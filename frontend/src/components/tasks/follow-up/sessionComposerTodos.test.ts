import { describe, expect, it } from 'vitest';
import {
  getComposerTodoItemView,
  getComposerTodoListState,
} from './sessionComposerTodos';

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

  it('derives completed todo presentation', () => {
    expect(getComposerTodoItemView('completed')).toEqual({
      marker: '\u2713',
      markerClassName: 'text-[hsl(var(--success))]',
      contentClassName: '',
    });
  });

  it('derives both running status spellings identically', () => {
    const expected = {
      marker: '\u25CF',
      markerClassName: 'text-primary',
      contentClassName: '',
    };

    expect(getComposerTodoItemView('in_progress')).toEqual(expected);
    expect(getComposerTodoItemView('in-progress')).toEqual(expected);
  });

  it('derives cancelled todo presentation without changing its marker', () => {
    expect(getComposerTodoItemView('cancelled')).toEqual({
      marker: '\u25CB',
      markerClassName: 'text-muted-foreground',
      contentClassName: 'line-through text-muted-foreground',
    });
  });
});
