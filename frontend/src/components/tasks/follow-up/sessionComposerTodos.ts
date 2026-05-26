export interface ComposerTodoListState {
  isEmpty: boolean;
  showCount: boolean;
}

export interface ComposerTodoItemView {
  marker: string;
  markerClassName: string;
  contentClassName: string;
}

export function getComposerTodoListState(
  todoCount: number
): ComposerTodoListState {
  return {
    isEmpty: todoCount === 0,
    showCount: todoCount > 0,
  };
}

export function getComposerTodoItemView(
  status: string
): ComposerTodoItemView {
  const isRunning = status === 'in_progress' || status === 'in-progress';

  if (status === 'completed') {
    return {
      marker: '\u2713',
      markerClassName: 'text-green-500',
      contentClassName: '',
    };
  }

  if (isRunning) {
    return {
      marker: '\u25CF',
      markerClassName: 'text-blue-500',
      contentClassName: '',
    };
  }

  return {
    marker: '\u25CB',
    markerClassName: 'text-muted-foreground',
    contentClassName:
      status === 'cancelled' ? 'line-through text-muted-foreground' : '',
  };
}
