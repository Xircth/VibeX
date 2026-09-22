export interface ComposerTodoListState {
  isEmpty: boolean;
  showCount: boolean;
}

/** Composer chrome the todo list sits above, rather than the trigger button. */
export const COMPOSER_TODO_ANCHOR_SELECTOR = '.session-composer-body';

export function getComposerTodoListState(
  todoCount: number
): ComposerTodoListState {
  return {
    isEmpty: todoCount === 0,
    showCount: todoCount > 0,
  };
}

export function resolveComposerTodoAnchor(
  from: Element | null
): HTMLElement | null {
  return from?.closest<HTMLElement>(COMPOSER_TODO_ANCHOR_SELECTOR) ?? null;
}
