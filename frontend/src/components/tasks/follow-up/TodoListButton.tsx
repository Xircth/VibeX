import { CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  getComposerTodoItemView,
  getComposerTodoListState,
} from './sessionComposerTodos';

interface TodoItem {
  content: string;
  status: string;
}

export function TodoListButton({ todos }: { todos: TodoItem[] }) {
  const { t } = useTranslation(['tasks', 'common']);
  const todoListState = getComposerTodoListState(todos.length);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('todoListButton.title')}
          aria-label={t('todoListButton.title')}
          className={cn(
            'composer-control flex items-center justify-center rounded-md px-1.5 py-0.5 transition-colors',
            todoListState.isEmpty && 'opacity-50'
          )}
        >
          <CheckSquare className="h-3.5 w-3.5" />
          {todoListState.showCount ? (
            <span className="ml-0.5 text-[10px] leading-none">
              {todos.length}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-2">
        {todoListState.isEmpty ? (
          <div className="py-2 text-center text-xs text-muted-foreground">
            {t('todoListButton.empty')}
          </div>
        ) : (
          <>
            <div className="mb-1.5 text-xs font-medium">
              {t('todoListButton.titleWithCount', { count: todos.length })}
            </div>
            <ul className="max-h-48 space-y-1 overflow-auto">
              {todos.map((todo, index) => {
                const todoItemView = getComposerTodoItemView(todo.status);

                return (
                  <li key={index} className="flex items-start gap-1.5 text-xs">
                    <span
                      className={cn(
                        'mt-0.5 shrink-0',
                        todoItemView.markerClassName
                      )}
                    >
                      {todoItemView.marker}
                    </span>
                    <span className={todoItemView.contentClassName}>
                      {todo.content}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
