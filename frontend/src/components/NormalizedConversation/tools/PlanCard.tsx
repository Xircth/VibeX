import { Check, Circle, CircleDot, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ActionType, NormalizedEntry, TodoItem } from 'shared/types';
import { AstryxMarkdown } from '../AstryxMarkdown';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

type ParsedPlanItem = {
  status: string;
  priority: string | null;
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
        priority: match[2]?.trim() || null,
        content: match[3].trim(),
      };
    })
    .filter((item): item is ParsedPlanItem => Boolean(item));
}

function todoToPlanItem(todo: TodoItem): ParsedPlanItem {
  return {
    status: todo.status,
    priority: todo.priority,
    content: todo.content,
  };
}

function getPlanStatusIcon(status: string) {
  const normalized = status.toLowerCase().replace(/-/g, '_');
  if (normalized === 'completed' || normalized === 'done') {
    return <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />;
  }
  if (normalized === 'in_progress' || normalized === 'inprogress') {
    return <CircleDot className="h-3.5 w-3.5 text-primary" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
}

function getPlanData(entry: NormalizedEntry): {
  items: ParsedPlanItem[];
  raw: string;
  operation?: string;
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
      operation: action.operation,
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
  const { t } = useTranslation(['conversation', 'common']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const planData = getPlanData(entry);
  const [expanded, toggle] = useExpandable(
    `plan-tool-entry:${expansionKey}`,
    defaultExpanded || toolEntry?.status.status === 'created'
  );
  const effectiveExpanded = forceExpanded || expanded;

  if (!toolEntry || !planData) return null;

  const firstItem = planData.items[0];
  const isStreaming =
    toolEntry.status.status === 'created' ||
    toolEntry.status.status === 'pending_approval';
  const detail =
    planData.operation ??
    (isStreaming
      ? t('planCard.updating')
      : firstItem
        ? t('planCard.itemsSummary', {
            count: planData.items.length,
            content: firstItem.content,
          })
        : t('planCard.planUpdated'));

  return (
    <ToolCardShell
      icon={<ClipboardList className="h-3 w-3" />}
      label={t('planCard.label')}
      detail={detail}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      {planData.items.length > 0 ? (
        <ol className="space-y-1.5 font-sans">
          {planData.items.map((item, index) => (
            <li
              key={`${item.status}:${item.content}:${index}`}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {getPlanStatusIcon(item.status)}
              </span>
              <span className="min-w-0 flex-1 break-words text-foreground">
                {item.content}
              </span>
              {item.priority ? (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {item.priority}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="conv-tool-details-content font-sans text-sm">
          <AstryxMarkdown
            taskAttemptId={taskAttemptId}
            className="whitespace-pre-wrap break-words"
          >
            {planData.raw}
          </AstryxMarkdown>
        </div>
      )}
    </ToolCardShell>
  );
}
