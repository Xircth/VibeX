import { useMemo } from 'react';
import type { TodoItem, NormalizedEntry } from 'shared/types';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';

interface UseTodosResult {
  todos: TodoItem[];
  inProgressTodo: TodoItem | null;
  lastUpdated: string | null;
}

const PLAN_ITEM_PATTERN =
  /^\s*(?:\d+[.)]|[-*])\s+\[([^\]|]+)(?:\s*\|\s*([^\]]+))?\]\s+(.+?)\s*$/;

function normalizeTodoStatus(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'inprogress') return 'in_progress';
  if (normalized === 'done') return 'completed';
  return normalized || 'pending';
}

function extractTodosFromPlan(plan: string): TodoItem[] {
  return plan
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(PLAN_ITEM_PATTERN);
      if (!match?.[1] || !match?.[3]) {
        return null;
      }

      return {
        status: normalizeTodoStatus(match[1]),
        priority: match[2]?.trim() || null,
        content: match[3].trim(),
      } satisfies TodoItem;
    })
    .filter((todo): todo is TodoItem => Boolean(todo));
}

/**
 * Hook that extracts and maintains the latest TODO state from normalized conversation entries.
 * Filters for TodoManagement/PlanPresentation ActionType entries and returns the most
 * recent task list, along with the currently in-progress todo item.
 */
export const useTodos = (entries: PatchTypeWithKey[]): UseTodosResult => {
  return useMemo(() => {
    let latestTodos: TodoItem[] = [];
    let lastUpdatedTime: string | null = null;

    for (const entry of entries) {
      if (entry.type === 'NORMALIZED_ENTRY' && entry.content) {
        const normalizedEntry = entry.content as NormalizedEntry;

        if (normalizedEntry.entry_type?.type === 'tool_use') {
          const actionType = normalizedEntry.entry_type.action_type;
          const partialTodos =
            actionType.action === 'todo_management'
              ? actionType.todos || []
              : actionType.action === 'plan_presentation'
                ? extractTodosFromPlan(actionType.plan)
                : [];

          if (partialTodos.length === 0) {
            continue;
          }

          const currentTimestamp =
            normalizedEntry.timestamp || new Date().toISOString();

          // Only update latestTodos if we have meaningful content OR this is our first entry
          const hasMeaningfulTodos =
            partialTodos.length > 0 &&
            partialTodos.every(
              (todo: TodoItem) =>
                todo.content && todo.content.trim().length > 0 && todo.status
            );
          const isNewerThanLatest =
            !lastUpdatedTime || currentTimestamp >= lastUpdatedTime;

          if (
            hasMeaningfulTodos ||
            (isNewerThanLatest && latestTodos.length === 0)
          ) {
            latestTodos = partialTodos;
            lastUpdatedTime = currentTimestamp;
          }
        }
      }
    }

    // Find the currently in-progress todo
    const inProgressTodo =
      latestTodos.find((todo) => {
        const status = todo.status?.toLowerCase();
        return status === 'in_progress' || status === 'in-progress';
      }) ?? null;

    return {
      todos: latestTodos,
      inProgressTodo,
      lastUpdated: lastUpdatedTime,
    };
  }, [entries]);
};
