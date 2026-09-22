export interface ComposerTodoListState {
  isEmpty: boolean;
  showCount: boolean;
}

export function getComposerTodoListState(
  todoCount: number
): ComposerTodoListState {
  return {
    isEmpty: todoCount === 0,
    showCount: todoCount > 0,
  };
}
