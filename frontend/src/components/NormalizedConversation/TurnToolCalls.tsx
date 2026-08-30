import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatToolCalls,
  type ChatToolCallItem,
  type ChatToolCallStatus,
} from '@astryxdesign/core/Chat';
import { ChevronDown, Images } from 'lucide-react';
import type {
  ActionType,
  ConversationDelegationView,
  FileChange,
  ImageData,
  MessageTurn,
  TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from './DisplayConversationEntry';
import { DelegationCard } from './conversation/DelegationCard';
import { HostDelegationLifecycleRow } from './conversation/HostDelegationLifecycleRow';
import {
  collectHostDelegationPollResults,
  isHostDelegationLifecycleTool,
  isHostDelegationTool,
  matchHostDelegationView,
  mergeHostDelegationView,
} from './conversation/hostDelegation';
import {
  isCompanionMcpDiscoverySearch,
  isCompanionSearchQuery,
} from './tools/subagentCardModel';
import { getToolSummary } from './conversation-entry-utils';
import type { IndexedTurnItem } from './messageTurnAggregate';
import type { ToolResultBlock, ToolUseBlock } from './messageTurnBlocks';
import { toolBlockToNormalizedEntry } from './messageTurnTool';
import { SubagentCard } from './tools/SubagentCard';
import {
  applySubagentLifecycle,
  buildSubagentCardModel,
  foldSubagentLifecycle,
  isNativeSubagentTool,
  isSubagentLifecycleTool,
  shouldHideLifecycleTool,
  type SubagentLifecycleEvent,
  type SubagentStatus,
} from './tools/subagentCardModel';
import { useSubagentLifecycleIndex } from './tools/SubagentLifecycleContext';
import { getToolChatStatus, ToolCallResultDetail } from './tools/ToolCardShell';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { fileReadLocation, resolveToolFilePath } from './tools/FileToolCard';
import { ToolCallTarget } from './tools/ToolCallTarget';
import { listDirPath } from './tools/toolDirListing';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useExpandable } from '@/stores/useExpandableStore';
import { cn } from '@/lib/utils';

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
type FileEditAction = Extract<ActionType, { action: 'file_edit' }>;

type ViewedImage = {
  key: string;
  image: ImageData;
  path: string;
};

function imageSource(image: ImageData): string | null {
  if (image.data) return `data:${image.mime_type};base64,${image.data}`;
  return image.uri ?? null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function ViewedImages({
  expansionKey,
  images,
}: {
  expansionKey: string;
  images: ViewedImage[];
}) {
  const { t } = useTranslation('conversation');
  const [expanded, toggle] = useExpandable(expansionKey, false);
  const openImagePreview = useOpenImagePreview();

  return (
    <section className="rounded-lg bg-card text-foreground">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        onClick={() => toggle()}
      >
        <Images className="h-4 w-4" aria-hidden="true" />
        <span>{t('viewedImages.summary', { count: images.length })}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform motion-reduce:transition-none',
            expanded ? 'rotate-0' : '-rotate-90'
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="flex flex-wrap gap-2 px-2 pb-2" role="list">
          {images.map(({ key, image, path }) => {
            const src = imageSource(image);
            if (!src) return null;
            return (
              <div key={key} role="listitem">
                <button
                  type="button"
                  className="h-24 w-24 overflow-hidden rounded-lg border border-border bg-muted/30 p-1 hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={path}
                  aria-label={t('viewedImages.preview', { path })}
                  onClick={() =>
                    openImagePreview({
                      imageUrl: src,
                      altText: path,
                      fileName: fileName(path),
                    })
                  }
                >
                  <img
                    src={src}
                    alt={path}
                    className="h-full w-full rounded-md object-contain"
                  />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

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
    panelActions?.openFilePreview(resolvedPath, {
      displayPath: title,
      title,
      location: fileReadLocation(action.line_start, action.line_end),
    });
  }, [
    action.line_end,
    action.line_start,
    action.path,
    panelActions,
    workspacePath,
  ]);
  const range =
    action.line_start != null
      ? action.line_end != null
        ? `L${action.line_start}–${action.line_end}`
        : `L${action.line_start}+`
      : null;

  return (
    <ToolCallTarget
      text={action.path}
      path={action.path}
      suffix={range}
      onClick={openPreview}
    />
  );
}

function FileEditPath({
  action,
  workspacePath,
}: {
  action: FileEditAction;
  workspacePath?: string | null;
}) {
  const panelActions = useOptionalPanelActionsContext();
  const openPreview = useCallback(() => {
    const resolvedPath = resolveToolFilePath(action.path, workspacePath);
    const relativePath = deriveRelativeFilePath(resolvedPath, workspacePath);
    const title = relativePath ?? action.path;
    panelActions?.openFilePreview(resolvedPath, {
      mode: 'diff',
      diffViewMode: 'inline',
      displayPath: title,
      title,
    });
  }, [action.path, panelActions, workspacePath]);
  return (
    <ToolCallTarget
      text={action.path}
      path={action.path}
      onClick={openPreview}
    />
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

function subagentChatStatus(status: SubagentStatus): ChatToolCallStatus {
  switch (status) {
    case 'running':
    case 'background':
      return 'running';
    case 'failed':
      return 'error';
    case 'completed':
      return 'complete';
  }
}

function HostDelegationToolCall({
  use,
  result,
  event,
  pollResults,
  onOpenChild,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  event: ConversationDelegationView | null;
  pollResults: readonly ToolResultBlock[];
  onOpenChild?: (childConversationId: string) => void;
}) {
  const delegation = mergeHostDelegationView(use, result, event, pollResults);
  return <DelegationCard delegation={delegation} onOpenChild={onOpenChild} />;
}

function SubagentToolCall({
  expansionKey,
  label,
  target,
  use,
  result,
  lifecycle,
  parentAgentId,
}: {
  expansionKey: string;
  label: string;
  target?: string;
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  lifecycle: SubagentLifecycleEvent[];
  parentAgentId?: string | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const model = applySubagentLifecycle(
    buildSubagentCardModel(use, result, parentAgentId),
    lifecycle
  );
  const toggle = () => setExpanded((open) => !open);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <div className="space-y-1">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={expansionKey}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className="cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChatToolCalls
          calls={[
            {
              key: expansionKey,
              name: label,
              target,
              status: subagentChatStatus(model.status),
            },
          ]}
        />
      </div>
      {expanded ? (
        <div id={expansionKey}>
          <SubagentCard
            use={use}
            result={result}
            lifecycle={lifecycle}
            parentAgentId={parentAgentId}
          />
        </div>
      ) : null}
    </div>
  );
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
  delegations = [],
  pollResults: suppliedPollResults,
  onOpenChild,
}: {
  turnId: string;
  timestamp: MessageTurn['timestamp'];
  offset: number;
  items: IndexedTurnItem[];
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath?: string | null;
  delegations?: ConversationDelegationView[];
  pollResults?: readonly ToolResultBlock[];
  onOpenChild?: (childConversationId: string) => void;
}) {
  const { t } = useTranslation('conversation');
  const lifecycleIndex = useSubagentLifecycleIndex();
  const parentAgentId = attempt.session?.agent_id ?? null;
  const entries = useMemo(
    () =>
      items.flatMap(({ item, index }) => {
        if (item.kind !== 'tool' || !item.use) return [];
        return [
          {
            entry: toolBlockToNormalizedEntry(item.use, item.result, timestamp),
            index,
            toolUseId: item.use.tool_use_id,
            images: item.use.images ?? [],
            use: item.use,
            result: item.result,
            isHostDelegation: isHostDelegationTool(item.use),
            isSubagent: isNativeSubagentTool(item.use),
          },
        ];
      }),
    [items, timestamp]
  );
  const folded = useMemo(() => {
    const localIds = new Set(
      entries.map((entry) => entry.use.tool_use_id).filter(Boolean)
    );
    return foldSubagentLifecycle(
      entries.map(({ use, result }) => ({ use, result })),
      lifecycleIndex.events.filter(
        (event) => !event.toolUseId || !localIds.has(event.toolUseId)
      )
    );
  }, [entries, lifecycleIndex.events]);
  const hostLifecycleEntries = useMemo(
    () => entries.filter((entry) => isHostDelegationLifecycleTool(entry.use)),
    [entries]
  );
  const regularEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (entry.isHostDelegation) return false;
        if (isHostDelegationLifecycleTool(entry.use)) return false;
        if (isCompanionMcpDiscoverySearch(entry.use)) return false;
        if (
          entry.entry.entry_type.type === 'tool_use' &&
          entry.entry.entry_type.action_type.action === 'search' &&
          isCompanionSearchQuery(entry.entry.entry_type.action_type.query)
        ) {
          return false;
        }
        if (entry.isSubagent) return false;
        if (!isSubagentLifecycleTool(entry.use)) return true;
        if (entry.toolUseId && folded.hiddenToolUseIds.has(entry.toolUseId)) {
          return false;
        }
        return !shouldHideLifecycleTool(
          entry.use,
          entry.result,
          lifecycleIndex.spawnBindingIds
        );
      }),
    [entries, folded.hiddenToolUseIds, lifecycleIndex.spawnBindingIds]
  );
  const hostDelegationEntries = useMemo(
    () => entries.filter((entry) => entry.isHostDelegation),
    [entries]
  );
  const pollResults = useMemo(
    () =>
      suppliedPollResults ??
      collectHostDelegationPollResults(
        entries.map(({ use, result }) => ({ use, result }))
      ),
    [entries, suppliedPollResults]
  );
  const subagentEntries = useMemo(
    () =>
      folded.cards.map((card) => {
        const match = entries.find(
          (entry) => entry.use.tool_use_id === card.use.tool_use_id
        );
        return {
          ...card,
          toolUseId: card.use.tool_use_id,
          index: match?.index ?? 0,
        };
      }),
    [entries, folded.cards]
  );

  const counts = useMemo(() => {
    const next = Object.fromEntries(
      SUMMARY_ORDER.map((category) => [category, 0])
    ) as Record<ToolSummaryCategory, number>;
    for (const { entry, images } of regularEntries) {
      if (images.length > 0) continue;
      if (entry.entry_type.type !== 'tool_use') continue;
      next[summaryCategory(entry.entry_type.action_type.action)] += 1;
    }
    return next;
  }, [regularEntries]);

  const label = SUMMARY_ORDER.flatMap((category) =>
    counts[category] > 0
      ? [
          t(`messageTurnView.toolSummary.${category}`, {
            count: counts[category],
          }),
        ]
      : []
  ).join(t('messageTurnView.toolSummary.separator'));

  const calls: ChatToolCallItem[] = regularEntries.flatMap(
    ({ entry, index, toolUseId, images }) => {
      if (images.length > 0) return [];
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
      const detailText =
        summary.detail && summary.detail !== summary.label
          ? summary.detail
          : entry.content.trim() && entry.content.trim() !== summary.label
            ? entry.content.trim()
            : '';
      return [
        {
          key: toolUseId || expansionKey,
          name: summary.label,
          additions: editStats.additions,
          deletions: editStats.deletions,
          stats:
            action.action === 'file_read' ? (
              <FileReadStats
                action={action}
                workspacePath={workspacePath ?? attempt.container_ref}
              />
            ) : action.action === 'file_edit' ? (
              <FileEditPath
                action={action}
                workspacePath={workspacePath ?? attempt.container_ref}
              />
            ) : action.action === 'tool' && action.tool_name === 'list_dir' ? (
              <ToolCallTarget
                text={listDirPath(action.arguments) || detailText}
                path={listDirPath(action.arguments) || detailText}
                isFolder
              />
            ) : detailText ? (
              <ToolCallTarget text={detailText} />
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
        },
      ];
    }
  );

  const viewedImages = regularEntries.flatMap(
    ({ entry, toolUseId, images }, entryIndex): ViewedImage[] => {
      if (images.length === 0 || entry.entry_type.type !== 'tool_use')
        return [];
      const action = entry.entry_type.action_type;
      return images.map((image, imageIndex) => ({
        key: `${toolUseId ?? entryIndex}:${imageIndex}`,
        image,
        path:
          action.action === 'file_read'
            ? action.path
            : image.uri || t('viewedImages.image', { count: imageIndex + 1 }),
      }));
    }
  );

  return (
    <div className="conv-entry-item vibex-turn-tool-calls space-y-1">
      {hostDelegationEntries.map(({ use, result, toolUseId, index }) => (
        <HostDelegationToolCall
          key={toolUseId || `${turnId}-delegation-${index}`}
          use={use}
          result={result}
          event={matchHostDelegationView(use, delegations)}
          pollResults={pollResults}
          onOpenChild={onOpenChild}
        />
      ))}
      {hostLifecycleEntries.map(({ use, result, toolUseId, index }) => (
        <HostDelegationLifecycleRow
          key={toolUseId || `${turnId}-delegation-status-${index}`}
          use={use}
          result={result}
        />
      ))}
      {subagentEntries.map(({ use, result, lifecycle, toolUseId, index }) => {
        const match = entries.find(
          (entry) => entry.use.tool_use_id === use.tool_use_id
        );
        const entry = match?.entry;
        const toolEntry =
          entry?.entry_type.type === 'tool_use' ? entry.entry_type : null;
        const summary = toolEntry
          ? getToolSummary(toolEntry, entry?.content.trim() ?? '')
          : { label: t('genericTool.subagent'), detail: '' };
        return (
          <SubagentToolCall
            key={toolUseId || `${turnId}-subagent-${index}`}
            expansionKey={`${turnId}-subagent-${toolUseId || index}`}
            label={summary.label}
            target={
              summary.detail && summary.detail !== summary.label
                ? summary.detail
                : undefined
            }
            use={use}
            result={result}
            lifecycle={lifecycle}
            parentAgentId={parentAgentId}
          />
        );
      })}
      {viewedImages.length > 0 ? (
        <ViewedImages
          expansionKey={`viewed-images:${turnId}:${offset}`}
          images={viewedImages}
        />
      ) : null}
      {calls.length > 0 ? (
        <ChatToolCalls
          calls={calls}
          label={label}
          alwaysGroup
          defaultIsExpanded={false}
        />
      ) : null}
    </div>
  );
}
