import type { ActionType, NormalizedEntry, TodoItem } from 'shared/types';
import { AstryxMarkdown } from '../AstryxMarkdown';
import { ConversationPlanCard } from '../ConversationPlanCard';
import { toConversationPlanItem } from '../conversationPlan';

type ParsedPlanItem = {
  status: string;
  content: string;
};

const PLAN_ITEM_PATTERN =
  /^\s*(?:\d+[.)]|[-*])\s+\[([^\]|]+)(?:\s*\|\s*([^\]]+))?\]\s+(.+?)\s*$/;

function isPlanAction(
  action: ActionType
): action is Extract<ActionType, { action: 'plan_presentation' }> {
  return action.action === 'plan_presentation';
}

function isTodoAction(
  action: ActionType
): action is Extract<ActionType, { action: 'todo_management' }> {
  return action.action === 'todo_management';
}

export function isPlanToolEntry(entry: NormalizedEntry): boolean {
  return (
    entry.entry_type.type === 'tool_use' &&
    (isPlanAction(entry.entry_type.action_type) ||
      isTodoAction(entry.entry_type.action_type))
  );
}

function parsePlanItems(plan: string): ParsedPlanItem[] {
  return plan
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(PLAN_ITEM_PATTERN);
      if (!match?.[1] || !match?.[3]) {
        return null;
      }

      return {
        status: match[1].trim(),
        content: match[3].trim(),
      };
    })
    .filter((item): item is ParsedPlanItem => Boolean(item));
}

function todoToPlanItem(todo: TodoItem): ParsedPlanItem {
  return {
    status: todo.status,
    content: todo.content,
  };
}

function getPlanData(entry: NormalizedEntry): {
  items: ParsedPlanItem[];
  raw: string;
} | null {
  if (entry.entry_type.type !== 'tool_use') return null;
  const action = entry.entry_type.action_type;

  if (isPlanAction(action)) {
    return {
      items: parsePlanItems(action.plan),
      raw: action.plan,
    };
  }

  if (isTodoAction(action)) {
    return {
      items: action.todos.map(todoToPlanItem),
      raw: action.todos
        .map((todo) => `${todo.status}: ${todo.content}`)
        .join('\n'),
    };
  }

  return null;
}

export function PlanCard({
  entry,
  expansionKey,
  defaultExpanded = false,
  forceExpanded = false,
  taskAttemptId,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
  defaultExpanded?: boolean;
  forceExpanded?: boolean;
  taskAttemptId?: string;
}) {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const planData = getPlanData(entry);

  if (!toolEntry || !planData) return null;

  const isStreaming =
    toolEntry.status.status === 'created' ||
    toolEntry.status.status === 'pending_approval';
  const awaitingConfirmation = toolEntry.status.status === 'pending_approval';

  return (
    <ConversationPlanCard
      items={planData.items.map(toConversationPlanItem)}
      expansionKey={expansionKey}
      defaultExpanded={defaultExpanded || isStreaming}
      forceExpanded={forceExpanded || awaitingConfirmation}
      awaitingConfirmation={awaitingConfirmation}
      isStreaming={isStreaming}
      fallback={
        planData.items.length === 0 ? (
          <AstryxMarkdown
            value={planData.raw}
            taskAttemptId={taskAttemptId}
            className="whitespace-pre-wrap break-words"
          />
        ) : null
      }
    />
  );
}
