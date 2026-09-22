import { CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ConversationPlanCard } from '@/components/NormalizedConversation/ConversationPlanCard';
import { toConversationPlanItem } from '@/components/NormalizedConversation/conversationPlan';
import { cn } from '@/lib/utils';
import { getComposerTodoListState } from './sessionComposerTodos';

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
      <PopoverContent
        align="end"
        side="top"
        className="composer-todo-popover"
      >
        {todoListState.isEmpty ? (
          <div className="px-3 py-2 text-center text-xs text-muted-foreground">
            {t('todoListButton.empty')}
          </div>
        ) : (
          <div
            className="composer-todo-list"
            tabIndex={0}
            role="region"
            aria-label={t('todoListButton.title')}
          >
            <ConversationPlanCard
              items={todos.map(toConversationPlanItem)}
              expansionKey="composer-todo-list"
              defaultExpanded
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
