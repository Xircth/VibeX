import {
  useCallback,
  useId,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChatToolCalls,
  type ChatToolCallItem,
  type ChatToolCallStatus,
} from '@astryxdesign/core/Chat';
import { ChevronDown, Images, Wrench } from 'lucide-react';
import type {
  ActionType,
  ConversationDelegationView,
  ConversationQuestionRequest,
  ConversationQuestionResponse,
  FileChange,
  ImageData,
  MessageTurn,
  TaskWithAttemptStatus,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import DisplayConversationEntry from './DisplayConversationEntry';
import { useDecodedTimelineImage } from './TimelineDecodedImage';
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
import {
  getToolCallDescription,
  getToolSummary,
} from './conversation-entry-utils';
import type { IndexedTurnItem } from './messageTurnAggregate';
import type {
  ToolResultBlock,
  ToolUseBlock,
  TurnRenderItem,
} from './messageTurnBlocks';
import { toolBlockToNormalizedEntry } from './messageTurnTool';
import { SubagentCard } from './tools/SubagentCard';
import { AskQuestionToolCard } from './tools/AskQuestionToolCard';
import {
  firstQuestionTitle,
  isAskQuestionTool,
  questionRequestFromToolUse,
  questionTabsFromRequest,
} from '@/components/tasks/follow-up/agentQuestionModel';
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
import {
  useExpandable,
  useExpandableGroup,
  useExpandableItems,
} from '@/stores/useExpandableStore';
import { cn } from '@/lib/utils';
import { ThinkingEntry } from './ThinkingEntry';

type ToolSummaryCategory =
  | 'commands'
  | 'reads'
  | 'edits'
  | 'searches'
  | 'webFetches'
  | 'agents'
  | 'otherActivities'
  | 'other';

const SUMMARY_ORDER: ToolSummaryCategory[] = [
  'commands',
  'reads',
  'edits',
  'searches',
  'webFetches',
  'agents',
  'other',
  'otherActivities',
];

const RECENT_ACTIVITIES = 2;

type ActivityEntry =
  | { kind: 'tool'; key: string; index: number; call: ChatToolCallItem }
  | {
      kind: 'visible';
      key: string;
      index: number;
      content: ReactNode;
      category?: ToolSummaryCategory | null;
    }
  | {
      kind: 'thinking';
      key: string;
      index: number;
      endIndex: number;
      texts: string[];
    };

function ToolCallBatch({
  calls,
  label,
  turnId,
}: {
  calls: ChatToolCallItem[];
  label: string;
  turnId: string;
}) {
  const [expanded, setExpanded] = useExpandableGroup(
    calls.map((call) => `tool-batch:${turnId}:${call.key}`)
  );
  return (
    <ChatToolCalls
      className="vibex-tool-call-batch"
      calls={calls}
      label={label}
      alwaysGroup
      isExpanded={expanded}
      onExpandedChange={setExpanded}
    />
  );
}

function MixedActivityBatch({
  entries,
  label,
  children,
}: {
  entries: ActivityEntry[];
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const [expanded, toggle] = useExpandableGroup(
    entries.map((entry) => entry.key)
  );
  return (
    <div className="conv-activity-batch">
      <button
        type="button"
        className="conv-activity-header"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => toggle()}
      >
        <Wrench className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown
          className={cn(
            'conv-thinking-chevron size-3.5 shrink-0',
            expanded && 'is-expanded'
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div id={id} className="conv-assistant-body mt-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}

type FileReadAction = Extract<ActionType, { action: 'file_read' }>;
type FileEditAction = Extract<ActionType, { action: 'file_edit' }>;

type ViewedImage = {
  key: string;
  image: ImageData;
  path: string;
};

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function ViewedImages({
  expansionKey,
  images,
  onExpandedChange,
}: {
  expansionKey: string;
  images: ViewedImage[];
  onExpandedChange: (expanded: boolean) => void;
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
        onClick={() => {
          onExpandedChange(!expanded);
          toggle();
        }}
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
          {images.map(({ key, image, path }) => (
            <ViewedImageThumb
              key={key}
              image={image}
              path={path}
              onOpen={(src) =>
                openImagePreview({
                  imageUrl: src,
                  altText: path,
                  fileName: fileName(path),
                })
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ViewedImageThumb({
  image,
  path,
  onOpen,
}: {
  image: ImageData;
  path: string;
  onOpen: (src: string) => void;
}) {
  const { t } = useTranslation('conversation');
  const src = useDecodedTimelineImage({
    imageKey: `${path}:${image.uri ?? ''}:${image.data.slice(0, 24)}`,
    enabled: true,
    data: image.data,
    mimeType: image.mime_type,
    uri: image.uri ?? null,
  });
  if (!src) return null;
  return (
    <div role="listitem">
      <button
        type="button"
        className="h-24 w-24 overflow-hidden rounded-lg border border-border bg-muted/30 p-1 hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={path}
        aria-label={t('viewedImages.preview', { path })}
        onClick={() => onOpen(src)}
      >
        <img
          src={src}
          alt={path}
          className="h-full w-full rounded-md object-contain"
        />
      </button>
    </div>
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
  expansionKey,
  onExpandedChange,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  event: ConversationDelegationView | null;
  pollResults: readonly ToolResultBlock[];
  onOpenChild?: (childConversationId: string) => void;
  expansionKey: string;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const delegation = mergeHostDelegationView(use, result, event, pollResults);
  return (
    <DelegationCard
      delegation={delegation}
      onOpenChild={onOpenChild}
      expansionKey={expansionKey}
      onExpandedChange={onExpandedChange}
    />
  );
}

function SubagentToolCall({
  expansionKey,
  label,
  target,
  use,
  result,
  lifecycle,
  parentAgentId,
  onExpandedChange,
}: {
  expansionKey: string;
  label: string;
  target?: string;
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  lifecycle: SubagentLifecycleEvent[];
  parentAgentId?: string | null;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useExpandable(expansionKey, true);
  const model = applySubagentLifecycle(
    buildSubagentCardModel(use, result, parentAgentId),
    lifecycle
  );
  const toggle = () => {
    onExpandedChange(!expanded);
    setExpanded(!expanded);
  };
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
            expansionKey={`${expansionKey}:sections`}
            onExpandedChange={onExpandedChange}
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

export type TimelineQuestion = {
  request: ConversationQuestionRequest;
  response: ConversationQuestionResponse | null;
};

export function TurnActivity({
  turnId,
  timestamp,
  items,
  attempt,
  task,
  workspacePath,
  delegations = [],
  pollResults: suppliedPollResults,
  onOpenChild,
  questions = [],
  isStreaming = false,
  showCompleted = true,
  renderOtherItem,
}: {
  turnId: string;
  timestamp: MessageTurn['timestamp'];
  items: IndexedTurnItem[];
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath?: string | null;
  delegations?: ConversationDelegationView[];
  pollResults?: readonly ToolResultBlock[];
  onOpenChild?: (childConversationId: string) => void;
  questions?: TimelineQuestion[];
  isStreaming?: boolean;
  showCompleted?: boolean;
  renderOtherItem?: (item: TurnRenderItem, index: number) => ReactNode;
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
            isAskQuestion: isAskQuestionTool(item.use),
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
        if (entry.isAskQuestion) return false;
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
  const askQuestionEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.isAskQuestion && !matchTimelineQuestion(entry.use, questions)
      ),
    [entries, questions]
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

  const callCategories = new Map<string, ToolSummaryCategory>();
  const rawCalls: (ChatToolCallItem & { index: number })[] =
    regularEntries.flatMap(({ entry, index, toolUseId, images }) => {
      if (images.length > 0) return [];
      if (entry.entry_type.type !== 'tool_use') {
        throw new Error('Turn tool aggregate received a non-tool entry');
      }
      const toolEntry = entry.entry_type;
      const summary = getToolSummary(toolEntry, entry.content.trim());
      const description = getToolCallDescription(entry);
      const expansionKey = `${turnId}-${index}`;
      const action = toolEntry.action_type;
      callCategories.set(
        toolUseId || expansionKey,
        summaryCategory(action.action)
      );
      const editStats =
        action.action === 'file_edit'
          ? fileEditStats(
              entry.fileEdits?.flatMap((edit) => edit.changes) ?? action.changes
            )
          : { additions: undefined, deletions: undefined };
      const detailText =
        summary.detail && summary.detail !== summary.label
          ? summary.detail
          : entry.content.trim() && entry.content.trim() !== summary.label
            ? entry.content.trim()
            : '';
      return [
        {
          index,
          key: toolUseId || expansionKey,
          name: description ?? summary.label,
          additions: editStats.additions,
          deletions: editStats.deletions,
          stats: description ? undefined : action.action === 'file_read' ? (
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
                workspacePath={workspacePath ?? attempt.container_ref}
                toolDetailOnly
              />
            </ToolCallResultDetail>
          ),
        },
      ];
    });

  const detailKeys = rawCalls.map(
    (call) => `tool-detail:${turnId}:${call.key}`
  );
  const [expandedDetails, setExpanded] = useExpandableItems(detailKeys);
  const calls = rawCalls.map((call, index) => ({
    ...call,
    isDetailExpanded: expandedDetails[index],
    onDetailExpandedChange: (expanded: boolean) => {
      setExpanded(detailKeys[index], expanded);
      if (expanded) setExpanded(`tool-batch:${turnId}:${call.key}`, true);
    },
  }));

  const summarizeActivities = (batch: ActivityEntry[]): string =>
    SUMMARY_ORDER.flatMap((category) => {
      const count = batch.filter(
        (entry) =>
          (entry.kind === 'tool'
            ? callCategories.get(String(entry.call.key))
            : entry.kind === 'visible'
              ? entry.category === undefined
                ? 'other'
                : entry.category
              : null) === category
      ).length;
      return count > 0
        ? [t(`messageTurnView.toolSummary.${category}`, { count })]
        : [];
    }).join(t('messageTurnView.toolSummary.separator'));

  const activityEntries: ActivityEntry[] = [
    ...calls.map(
      (call): ActivityEntry => ({
        kind: 'tool',
        key: `tool-batch:${turnId}:${call.key}`,
        index: call.index,
        call,
      })
    ),
    ...askQuestionEntries.map(
      ({ use, result, toolUseId, index }): ActivityEntry => {
        const matched = matchTimelineQuestion(use, questions);
        return {
          kind: 'visible',
          key: `tool-batch:${turnId}:${toolUseId || index}`,
          index,
          content: (
            <AskQuestionToolCard
              use={use}
              result={result}
              request={matched?.request}
              response={matched?.response ?? null}
              expansionKey={`question-details:${turnId}:${toolUseId || index}`}
              onExpandedChange={(expanded) => {
                if (expanded)
                  setExpanded(
                    `tool-batch:${turnId}:${toolUseId || index}`,
                    true
                  );
              }}
            />
          ),
        };
      }
    ),
    ...hostDelegationEntries.map(
      ({ use, result, toolUseId, index }): ActivityEntry => ({
        kind: 'visible',
        key: `tool-batch:${turnId}:${toolUseId || index}`,
        category: 'agents',
        index,
        content: (
          <HostDelegationToolCall
            use={use}
            result={result}
            event={matchHostDelegationView(use, delegations)}
            pollResults={pollResults}
            onOpenChild={onOpenChild}
            expansionKey={`delegation-details:${turnId}:${toolUseId || index}`}
            onExpandedChange={(expanded) => {
              if (expanded)
                setExpanded(`tool-batch:${turnId}:${toolUseId || index}`, true);
            }}
          />
        ),
      })
    ),
    ...hostLifecycleEntries.map(
      ({ use, result, toolUseId, index }): ActivityEntry => ({
        kind: 'visible',
        key: `tool-batch:${turnId}:${toolUseId || index}`,
        index,
        content: <HostDelegationLifecycleRow use={use} result={result} />,
      })
    ),
    ...subagentEntries.map(
      ({ use, result, lifecycle, toolUseId, index }): ActivityEntry => {
        const match = entries.find(
          (entry) => entry.use.tool_use_id === use.tool_use_id
        );
        const entry = match?.entry;
        const toolEntry =
          entry?.entry_type.type === 'tool_use' ? entry.entry_type : null;
        const summary = toolEntry
          ? getToolSummary(toolEntry, entry?.content.trim() ?? '')
          : { label: t('genericTool.subagent'), detail: '' };
        return {
          kind: 'visible',
          key: `tool-batch:${turnId}:${toolUseId || index}`,
          category: 'agents',
          index,
          content: (
            <SubagentToolCall
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
              onExpandedChange={(expanded) => {
                if (expanded)
                  setExpanded(
                    `tool-batch:${turnId}:${toolUseId || index}`,
                    true
                  );
              }}
            />
          ),
        };
      }
    ),
    ...regularEntries.flatMap(
      ({ entry, toolUseId, images, index }): ActivityEntry[] => {
        if (images.length === 0 || entry.entry_type.type !== 'tool_use')
          return [];
        const action = entry.entry_type.action_type;
        const key = `viewed-images:${turnId}:${toolUseId || index}`;
        return [
          {
            kind: 'visible',
            key,
            category: summaryCategory(action.action),
            index,
            content: (
              <ViewedImages
                expansionKey={`${key}:details`}
                onExpandedChange={(expanded) => {
                  if (expanded) setExpanded(key, true);
                }}
                images={images.map((image, imageIndex) => ({
                  key: `${key}:${imageIndex}`,
                  image,
                  path:
                    action.action === 'file_read'
                      ? action.path
                      : image.uri ||
                        t('viewedImages.image', { count: imageIndex + 1 }),
                }))}
              />
            ),
          },
        ];
      }
    ),
  ];

  for (const { item, index } of items) {
    if (item.kind !== 'thinking') {
      if (item.kind !== 'tool' || !item.use) {
        activityEntries.push({
          kind: 'visible',
          key: `activity:${turnId}:${index}`,
          index,
          category: 'otherActivities',
          content: renderOtherItem?.(item, index),
        });
      }
      continue;
    }
    const previous = activityEntries.at(-1);
    if (previous?.kind === 'thinking' && previous.endIndex === index - 1) {
      previous.texts.push(item.text);
      previous.endIndex = index;
    } else {
      activityEntries.push({
        kind: 'thinking',
        key: `thinking-batch:${turnId}:${index}`,
        index,
        endIndex: index,
        texts: [item.text],
      });
    }
  }
  activityEntries.sort((a, b) => a.index - b.index);

  if (!showCompleted) return null;

  const recentStart =
    [...new Set(activityEntries.map((entry) => entry.index))].at(
      -RECENT_ACTIVITIES
    ) ?? -Infinity;
  const lastIndex = items.at(-1)?.index;
  const activityUnits: {
    kind: 'recent' | 'batch';
    entries: ActivityEntry[];
  }[] = [];
  let batch: ActivityEntry[] = [];
  for (const entry of activityEntries) {
    const keepVisible = isStreaming && entry.index >= recentStart;
    if (keepVisible) {
      if (batch.length > 0)
        activityUnits.push({ kind: 'batch', entries: batch });
      batch = [];
      activityUnits.push({ kind: 'recent', entries: [entry] });
    } else {
      batch.push(entry);
    }
  }
  if (batch.length > 0) activityUnits.push({ kind: 'batch', entries: batch });

  const renderActivity = (entry: ActivityEntry): ReactNode => {
    if (entry.kind === 'visible')
      return <div key={entry.key}>{entry.content}</div>;
    if (entry.kind === 'tool')
      return <ChatToolCalls key={entry.key} calls={[entry.call]} />;
    return (
      <ThinkingEntry
        key={entry.key}
        content={entry.texts.join('\n\n')}
        count={entry.texts.length}
        expansionKey={`${turnId}-${entry.index}`}
        taskAttemptId={attempt.id}
        taskId={task?.id ?? attempt.task_id ?? undefined}
        workspacePath={workspacePath ?? attempt.container_ref}
        isStreaming={isStreaming && entry.endIndex === lastIndex}
        onExpandedChange={(expanded) => {
          if (expanded) setExpanded(entry.key, true);
        }}
      />
    );
  };

  if (activityUnits.length === 0) return null;

  return (
    <div className="conv-entry-item vibex-turn-tool-calls flex flex-col gap-1">
      {activityUnits.map((unit) => {
        const key = unit.entries[0].key;
        if (unit.kind === 'recent') return renderActivity(unit.entries[0]);
        const batchCalls = unit.entries.flatMap((entry) =>
          entry.kind === 'tool' ? [entry.call] : []
        );
        const thinkingCount = unit.entries.reduce(
          (count, entry) =>
            count + (entry.kind === 'thinking' ? entry.texts.length : 0),
          0
        );
        if (unit.entries.every((entry) => entry.kind === 'thinking'))
          return unit.entries.map(renderActivity);
        const otherCount = unit.entries.filter(
          (entry) => entry.kind === 'visible'
        ).length;
        const label = summarizeActivities(unit.entries);
        return thinkingCount === 0 && otherCount === 0 ? (
          <ToolCallBatch
            key={key}
            turnId={turnId}
            calls={batchCalls}
            label={label}
          />
        ) : (
          <MixedActivityBatch key={key} entries={unit.entries} label={label}>
            {unit.entries.map(renderActivity)}
          </MixedActivityBatch>
        );
      })}
    </div>
  );
}

function matchTimelineQuestion(
  use: ToolUseBlock,
  questions: TimelineQuestion[]
): TimelineQuestion | null {
  if (questions.length === 0) return null;
  if (questions.length === 1) return questions[0] ?? null;
  const title = firstQuestionTitle(
    questionTabsFromRequest(questionRequestFromToolUse(use))
  );
  if (!title) return questions[0] ?? null;
  return (
    questions.find((item) => {
      const prompt = item.request.prompt;
      const headers = questionTabsFromRequest(item.request).map(
        (question) => question.question
      );
      return prompt.includes(title) || headers.includes(title);
    }) ?? null
  );
}
