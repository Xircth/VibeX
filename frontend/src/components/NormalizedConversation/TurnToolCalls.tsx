import {
  useCallback,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChatToolCalls, type ChatToolCallItem } from '@astryxdesign/core/Chat';
import type {
  ActionType,
  FileChange,
  MessageTurn,
  TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from './DisplayConversationEntry';
import { getToolSummary } from './conversation-entry-utils';
import type { IndexedTurnItem } from './messageTurnAggregate';
import { toolBlockToNormalizedEntry } from './messageTurnTool';
import { getToolChatStatus, ToolCallResultDetail } from './tools/ToolCardShell';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { resolveToolFilePath } from './tools/FileToolCard';

type ToolSummaryCategory =
  | 'commands'
  | 'reads'
  | 'edits'
  | 'searches'
  | 'webFetches'
  | 'agents'
  | 'other';

const SUMMARY_ORDER: ToolSummaryCategory[] = [
  'commands',
  'reads',
  'edits',
  'searches',
  'webFetches',
  'agents',
  'other',
];

type FileReadAction = Extract<ActionType, { action: 'file_read' }>;

function FileReadStats({
  action,
  workspacePath,
}: {
  action: FileReadAction;
  workspacePath?: string | null;
}) {
  const panelActions = useOptionalPanelActionsContext();
  const openPreview = useCallback(() => {
    const resolvedPath = resolveToolFilePath(action.path, workspacePath);
    const relativePath = deriveRelativeFilePath(resolvedPath, workspacePath);
    const title = relativePath ?? action.path;
    panelActions?.openFilePreview(resolvedPath, { displayPath: title, title });
  }, [action.path, panelActions, workspacePath]);
  const stopAndOpen = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    openPreview();
  };
  const stopKeyboardBubble = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const range =
    action.line_start != null
      ? action.line_end != null
        ? `L${action.line_start}–${action.line_end}`
        : `L${action.line_start}+`
      : null;

  return (
    <>
      <button
        type="button"
        className="vibex-tool-file-link"
        title={action.path}
        aria-label={action.path}
        onClick={stopAndOpen}
        onKeyDown={stopKeyboardBubble}
      >
        {action.path}
      </button>
      {range ? <span>{range}</span> : null}
    </>
  );
}

function countDiff(change: FileChange): {
  additions: number;
  deletions: number;
} {
  if (change.action === 'write') {
    return { additions: change.content.split(/\r?\n/).length, deletions: 0 };
  }
  if (change.action !== 'edit') return { additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;
  for (const line of change.unified_diff.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function fileEditStats(changes: FileChange[]) {
  const totals = changes.reduce(
    (sum, change) => {
      const next = countDiff(change);
      return {
        additions: sum.additions + next.additions,
        deletions: sum.deletions + next.deletions,
      };
    },
    { additions: 0, deletions: 0 }
  );
  return {
    additions: totals.additions > 0 ? totals.additions : undefined,
    deletions: totals.deletions > 0 ? totals.deletions : undefined,
  };
}

function summaryCategory(action: string): ToolSummaryCategory {
  switch (action) {
    case 'command_run':
      return 'commands';
    case 'file_read':
      return 'reads';
    case 'file_edit':
      return 'edits';
    case 'search':
      return 'searches';
    case 'web_fetch':
      return 'webFetches';
    case 'task_create':
      return 'agents';
    default:
      return 'other';
  }
}

export function TurnToolCalls({
  turnId,
  timestamp,
  offset,
  items,
  attempt,
  task,
  workspacePath,
}: {
  turnId: string;
  timestamp: MessageTurn['timestamp'];
  offset: number;
  items: IndexedTurnItem[];
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath?: string | null;
}) {
  const { t } = useTranslation('conversation');
  const entries = useMemo(
    () =>
      items.flatMap(({ item, index }) => {
        if (item.kind !== 'tool' || !item.use) return [];
        return [
          {
            entry: toolBlockToNormalizedEntry(item.use, item.result, timestamp),
            index,
            toolUseId: item.use.tool_use_id,
          },
        ];
      }),
    [items, timestamp]
  );

  const counts = useMemo(() => {
    const next = Object.fromEntries(
      SUMMARY_ORDER.map((category) => [category, 0])
    ) as Record<ToolSummaryCategory, number>;
    for (const { entry } of entries) {
      if (entry.entry_type.type !== 'tool_use') continue;
      next[summaryCategory(entry.entry_type.action_type.action)] += 1;
    }
    return next;
  }, [entries]);

  const label = SUMMARY_ORDER.flatMap((category) =>
    counts[category] > 0
      ? [
          t(`messageTurnView.toolSummary.${category}`, {
            count: counts[category],
          }),
        ]
      : []
  ).join(t('messageTurnView.toolSummary.separator'));

  const calls: ChatToolCallItem[] = entries.map(
    ({ entry, index, toolUseId }) => {
      if (entry.entry_type.type !== 'tool_use') {
        throw new Error('Turn tool aggregate received a non-tool entry');
      }
      const toolEntry = entry.entry_type;
      const summary = getToolSummary(toolEntry, entry.content.trim());
      const expansionKey = `${turnId}-${offset + index}`;
      const action = toolEntry.action_type;
      const editStats =
        action.action === 'file_edit'
          ? fileEditStats(action.changes)
          : { additions: undefined, deletions: undefined };
      return {
        key: toolUseId || expansionKey,
        name: summary.label,
        target:
          action.action === 'file_read'
            ? undefined
            : summary.detail || entry.content.trim() || undefined,
        additions: editStats.additions,
        deletions: editStats.deletions,
        stats:
          action.action === 'file_read' ? (
            <FileReadStats
              action={action}
              workspacePath={workspacePath ?? attempt.container_ref}
            />
          ) : undefined,
        status: getToolChatStatus(toolEntry.status),
        errorMessage:
          toolEntry.status.status === 'failed'
            ? t('messageTurnView.toolSummary.failed')
            : undefined,
        resultDetail: (
          <ToolCallResultDetail>
            <DisplayConversationEntry
              entry={entry}
              expansionKey={expansionKey}
              taskAttempt={attempt}
              task={task ?? undefined}
              toolDetailOnly
            />
          </ToolCallResultDetail>
        ),
      };
    }
  );

  return (
    <div className="conv-entry-item vibex-turn-tool-calls">
      <ChatToolCalls
        calls={calls}
        label={label}
        alwaysGroup
        defaultIsExpanded={false}
      />
    </div>
  );
}
