import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatToolCalls, type ChatToolCallItem } from '@astryxdesign/core/Chat';
import type { MessageTurn, TaskWithAttemptStatus } from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from './DisplayConversationEntry';
import { getToolSummary } from './conversation-entry-utils';
import type { IndexedTurnItem } from './messageTurnAggregate';
import { toolBlockToNormalizedEntry } from './messageTurnTool';
import { getToolChatStatus, ToolCallResultDetail } from './tools/ToolCardShell';

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
}: {
  turnId: string;
  timestamp: MessageTurn['timestamp'];
  offset: number;
  items: IndexedTurnItem[];
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
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
      return {
        key: toolUseId || expansionKey,
        name: summary.label,
        target: summary.detail || entry.content.trim() || undefined,
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
