import { describe, expect, it } from 'vitest';
import {
  COMPOSER_TODO_ANCHOR_SELECTOR,
  getComposerTodoListState,
  resolveComposerTodoAnchor,
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

  it('resolves the composer body from a nested trigger', () => {
    const composer = document.createElement('div');
    composer.className = 'composer-shell session-composer-body';
    const trigger = document.createElement('button');
    composer.appendChild(trigger);
    document.body.appendChild(composer);

    expect(COMPOSER_TODO_ANCHOR_SELECTOR).toBe('.session-composer-body');
    expect(resolveComposerTodoAnchor(trigger)).toBe(composer);
    expect(resolveComposerTodoAnchor(null)).toBeNull();

    composer.remove();
  });
});
