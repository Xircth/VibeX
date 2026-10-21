import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import { Loader2 } from 'lucide-react';
import { ConversationTimelineSkeleton } from '@/components/logs/ConversationTimelineSkeleton';
import { ConversationFindBar } from '@/components/NormalizedConversation/conversation/ConversationFindBar';
import { findInConversationTimeline } from '@/lib/conversationFind';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAppContextMenu } from '@/components/context-menu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { ConversationSelectionToolbar } from '@/components/NormalizedConversation/ConversationSelectionToolbar';
import { copyConversationMarkdown } from '@/lib/copyConversationMarkdown';
import { exportConversation } from '@/lib/exportConversation';
import { requestCreateSessionInExecutionArea } from '@/lib/requestCreateSession';
import { writeClipboardViaBridge } from '@/vscode/bridge';

import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AgentElicitationResponse,
  AgentKind,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  ConversationFileChange,
  MessageTurn,
  PlanEntry,
  TaskWithAttemptStatus,
  TimelineRow,
  TokenUsageInfo,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import {
  MessageTurnView,
  type ContextCompactPresentation,
} from '@/components/NormalizedConversation/MessageTurnView';
import { TurnFileChangesCard } from '@/components/NormalizedConversation/TurnFileChangesCard';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { ChildConversationViewer } from '@/components/NormalizedConversation/conversation/ChildConversationViewer';
import {
  appendChildConversationStack,
  popChildConversationStack,
} from '@/components/NormalizedConversation/conversation/childConversationStack';

import { SubagentLifecycleProvider } from '@/components/NormalizedConversation/tools/SubagentLifecycleContext';
import { ConversationStatusDock } from '@/components/tasks/follow-up/ConversationStatusDock';
import { ArtifactTimelineCard } from '@/components/NormalizedConversation/ArtifactTimelineCard';
import { PluginTimelineCards } from '@/components/plugins/PluginTimelineCards';
import { agentsApi } from '@/features/agents/api';
import { publishLiveSessionControls } from '@/features/agents/sessionControlsQuery';
import { conversationApi } from '@/features/conversation/conversationApi';
import { getComposerSteeringTarget } from '@/components/tasks/follow-up/sessionComposerSteering';
import { ConversationChildrenSummary } from '@/features/conversation/ConversationChildrenSummary';
import { PiProjectTrustBanner } from '@/features/conversation/PiProjectTrustBanner';
import {
  AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID,
  AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
  AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
  AUTO_PERMISSION_NOTICE_ROW_ID,
  isResendColdStartNotice,
  sessionNoticeNeedsRebind,
} from '@/features/conversation/sessionNoticeNeedsRebind';
import { nextSurfaceActive } from '@/features/conversation/surfaceActivity';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import { ConfirmDialog } from '@/components/dialogs';
import {
  ResendCheckpointDialog,
  shouldConfirmResendCheckpoint,
} from '@/components/dialogs';
import { loadResendCheckpointPreview } from './resendCheckpointPreview';
import { getErrorMessage } from '@/lib/modals';
import { toast } from '@/components/ui/toast';
import { TurnStats } from '@/components/conversation-thread/TurnStats';
import { LiveTurnStats } from '@/components/conversation-thread/LiveTurnStats';
import {
  asFiniteNumber,
  turnTokenTotal,
  type TurnStatsData,
} from '@/components/conversation-thread/turnStatsModel';
import { useUserSystem } from '@/components/ConfigProvider';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import {
  findActiveConversationMessageNavEntry,
  type ConversationMessageNavEntry,
} from '@/components/conversation-thread/messageNavEntries';
import {
  isDurableHostNote,
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { WorkflowRunCard } from '@/features/workflow/WorkflowRunCard';
import { useOptionalEntries } from '@/contexts/EntriesContext';
import {
  useOptionalConversationStatus,
  type ConversationStatusNotice,
} from '@/contexts/ConversationStatusContext';
import { useOptionalKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import {
  resolveResendExecutorProfile,
  useActiveExecutorProfile,
} from '@/contexts/ActiveExecutorProfileContext';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  resolveConversationCollapsePreferences,
  resolveHideModelThinking,
} from '@/lib/conversationCollapsePreferences';
import {
  isExpandableOpen,
  useExpandableRevision,
} from '@/stores/useExpandableStore';
import { buildTimelineVirtualEntries } from './assistantVirtualSlices';
import { TimelineImagePanel } from '@/components/NormalizedConversation/TimelineDecodedImage';
import { cn } from '@/lib/utils';
import { isContextCompactPrompt } from '@/lib/contextCompact';
import { composerMessageHistoryFromTurns } from '@/components/tasks/follow-up/sessionComposerHistory';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { bindConversationSummaryMarquee } from './conversationSummaryMarquee';
import {
  CONVERSATION_OPEN_SETTLE_PASSES,
  ESTIMATED_CONVERSATION_ROW_HEIGHT,
  cancelVirtualizerFollowScroll,
  conversationFollowIntent,
  conversationTailFollowAction,
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getVirtualRowTranslateY,
  isConversationExpansionToggle,
  isConversationNearBottom,
  measureScrollMargin,
  measureUnscaledBlockHeight,
  observeUnscaledElementRect,
  scheduleMeasuredScrollToIndex,
  scrollTopAfterPrepend,
  wheelDetachesConversationFollow,
  type VirtualizedListRef,
} from './VirtualizedList';

const OVERSCAN = 10;

function timelineItemAsMessage(
  entry: ConversationTimelineTurn | ConversationTimelineItem
): ConversationTimelineTurn | null {
  if ('kind' in entry) {
    return entry.kind === 'message' ? entry.item : null;
  }
  return entry;
}

export function conversationThreadMaxWidthClass(
  widthMode: 'bounded' | 'workspace',
  isEditorAreaVisible: boolean
): 'max-w-none' | 'max-w-6xl' {
  return widthMode === 'workspace' && !isEditorAreaVisible
    ? 'max-w-none'
    : 'max-w-6xl';
}

export const LOAD_OLDER_THRESHOLD_PX = 240;

export function shouldLoadOlderTimelinePage(input: {
  hasEarlier: boolean;
  isAtBottom: boolean;
  scrollTop: number;
  previousScrollTop: number;
}): boolean {
  const crossedDownward =
    input.previousScrollTop > LOAD_OLDER_THRESHOLD_PX &&
    input.scrollTop <= LOAD_OLDER_THRESHOLD_PX;
  return input.hasEarlier && !input.isAtBottom && crossedDownward;
}

interface AgentTimelineConversationProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onAtBottomChange?: (isAtBottom: boolean) => void;
  widthMode?: 'bounded' | 'workspace';
}

/** Nav dots derived from the timeline's user turns (one dot per user message). */
export function buildTimelineNavEntries(
  timeline: Array<ConversationTimelineTurn | ConversationTimelineItem>
): ConversationMessageNavEntry[] {
  const entries: ConversationMessageNavEntry[] = [];
  let ordinal = 0;
  timeline.forEach((entry, index) => {
    const row = timelineItemAsMessage(entry);
    if (!row || row.turn.role !== 'user') return;
    ordinal += 1;
    const preview =
      row.turn.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80) || `User message ${ordinal}`;
    entries.push({
      key: row.key,
      index,
      ordinal,
      preview,
      additions: 0,
      deletions: 0,
    });
  });
  return entries;
}

export function vibexTurnIdFromTimelineRowId(rowId: string): string {
  return rowId.replace(/:(?:assistant(?::\d+)?|user)$/u, '');
}

export function isTimelineTurnInFlight(
  timeline: ConversationTimelineTurn[]
): boolean {
  return timeline.some((row) => {
    if (row.phase !== 'streaming' && row.phase !== 'optimistic') {
      return false;
    }
    if (row.turn.role !== 'assistant') {
      return true;
    }
    const baseId = vibexTurnIdFromTimelineRowId(row.turn.id);
    const userId = baseId !== row.turn.id ? `${baseId}:user` : null;
    if (!userId) {
      return true;
    }
    const user = timeline.find(
      (candidate) =>
        candidate.turn.role === 'user' && candidate.turn.id === userId
    );
    return !user || user.phase === 'streaming' || user.phase === 'optimistic';
  });
}

export function getLatestTimelinePlanEntries(
  timeline: ConversationTimelineTurn[]
): PlanEntry[] {
  let latest: PlanEntry[] = [];

  for (const row of timeline) {
    for (const block of row.turn.blocks) {
      if (block.type === 'plan') {
        latest = block.entries;
      }
    }
  }

  return latest;
}

/** Only the latest user message offers edit-and-resend, including while its
 * assistant turn is still in flight. */
export function isEditableUserTimelineRow(
  row: ConversationTimelineTurn,
  lastUserRowKey: string | null
): boolean {
  return row.turn.role === 'user' && row.key === lastUserRowKey;
}

function buildContextCompactPresentation(
  row: ConversationTimelineTurn,
  userTurn: MessageTurn | undefined
): ContextCompactPresentation | null {
  if (row.turn.role !== 'assistant') return null;
  const prompt = userTurn?.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n');
  if (!isContextCompactPrompt(prompt)) return null;

  const status =
    row.phase === 'streaming' || row.phase === 'optimistic'
      ? 'running'
      : row.phase === 'failed' ||
          row.phase === 'cancelled' ||
          row.phase === 'interrupted'
        ? 'failed'
        : 'success';
  const usage = row.turn.usage;
  const contextTokens = usage
    ? Number(
        usage.context_used ??
          Number(usage.input_tokens) +
            Number(usage.output_tokens) +
            Number(usage.cache_creation_input_tokens) +
            Number(usage.cache_read_input_tokens)
      )
    : null;

  return {
    status,
    durationMs:
      row.turn.duration_ms != null ? Number(row.turn.duration_ms) : null,
    contextTokens:
      contextTokens != null && contextTokens > 0 ? contextTokens : null,
  };
}

export function contextCompactPresentationForRow(
  timeline: ConversationTimelineTurn[],
  index: number
): ContextCompactPresentation | null {
  const row = timeline[index];
  if (!row || row.turn.role !== 'assistant') return null;
  const baseId = vibexTurnIdFromTimelineRowId(row.turn.id);
  const targetUserId = `${baseId}:user`;
  let userTurn: MessageTurn | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = timeline[i];
    if (candidate?.turn.id === targetUserId) {
      userTurn = candidate.turn;
      break;
    }
  }
  return buildContextCompactPresentation(row, userTurn);
}

export function buildContextCompactPresentationByRowKey(
  timeline: ConversationTimelineTurn[]
): Map<string, ContextCompactPresentation | null> {
  const byRowKey = new Map<string, ContextCompactPresentation | null>();
  const latestTurnById = new Map<string, MessageTurn>();

  for (const row of timeline) {
    if (row.turn.role === 'assistant') {
      const baseId = vibexTurnIdFromTimelineRowId(row.turn.id);
      const userTurn = latestTurnById.get(`${baseId}:user`);
      byRowKey.set(row.key, buildContextCompactPresentation(row, userTurn));
    } else {
      byRowKey.set(row.key, null);
    }
    latestTurnById.set(row.turn.id, row.turn);
  }

  return byRowKey;
}

function assistantCopyText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n');
}

function turnCopyText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n')
    .trim();
}

/**
 * Latest assistant-turn token usage for the composer's context-usage ring,
 * shaped from the agent-reported context window. Returns null (which hides the
 * indicator) unless a turn carries a real context_window_max — agents that
 * don't report a window simply don't show the ratio.
 */
function latestTokenUsage(
  timeline: ConversationTimelineTurn[]
): TokenUsageInfo | null {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const turn = timeline[index]?.turn;
    const usage = turn?.usage;
    if (!turn || turn.role !== 'assistant' || !usage) continue;
    const window =
      usage.context_window_max != null ? Number(usage.context_window_max) : 0;
    if (window <= 0) continue;
    const breakdown =
      Number(usage.input_tokens) +
      Number(usage.output_tokens) +
      Number(usage.cache_creation_input_tokens) +
      Number(usage.cache_read_input_tokens);
    const total =
      usage.context_used != null ? Number(usage.context_used) : breakdown;
    if (total <= 0) continue;
    return { total_tokens: total, model_context_window: window };
  }
  return null;
}

function usageWindow(usage: MessageTurn['usage']): number | null {
  const window = asFiniteNumber(usage?.context_window_max);
  return window !== null && window > 0 ? window : null;
}

export function buildLiveTurnStats(input: {
  timeline: ConversationTimelineTurn[];
  composerTokenUsage: TokenUsageInfo | null;
  sessionConfigOptions?: AgentSessionConfigOption[];
}): TurnStatsData {
  let activeModel: string | null = null;
  let activeTotalTokens: number | null = null;
  let activeContextWindow: number | null = null;

  for (let index = input.timeline.length - 1; index >= 0; index -= 1) {
    const row = input.timeline[index];
    if (!row || row.turn.role !== 'assistant') continue;
    if (!activeModel && row.turn.model?.trim()) {
      activeModel = row.turn.model.trim();
    }
    if (row.turn.usage) {
      const total = turnTokenTotal(row.turn.usage);
      if (activeTotalTokens === null && total !== null) {
        activeTotalTokens = total;
      }
      const window = usageWindow(row.turn.usage);
      if (activeContextWindow === null && window !== null) {
        activeContextWindow = window;
      }
    }
    if (
      activeModel &&
      activeTotalTokens !== null &&
      activeContextWindow !== null
    ) {
      break;
    }
  }

  if (!activeModel && input.sessionConfigOptions) {
    const modelOption = input.sessionConfigOptions.find(
      (option) => option.category === 'model' || option.key === 'model'
    );
    if (typeof modelOption?.value === 'string' && modelOption.value.trim()) {
      activeModel = modelOption.value.trim();
    }
  }

  return {
    model: activeModel,
    totalTokens:
      activeTotalTokens ?? input.composerTokenUsage?.total_tokens ?? null,
    contextWindow:
      activeContextWindow ??
      input.composerTokenUsage?.model_context_window ??
      null,
  };
}

/** Turn stats for a settled assistant turn, sourced from the parsed MessageTurn. */
export function buildSettledTurnStats(turn: MessageTurn): TurnStatsData {
  const usage = turn.usage ?? null;
  return {
    model: turn.model ?? null,
    startedAt: turn.timestamp,
    totalTokens: turnTokenTotal(usage),
    contextWindow: usageWindow(usage),
    cacheReadTokens: asFiniteNumber(usage?.cache_read_input_tokens),
    cacheWriteTokens: asFiniteNumber(usage?.cache_creation_input_tokens),
    elapsedMs: asFiniteNumber(turn.duration_ms),
    completedAt: turn.completed_at ?? null,
    stopReason: null,
  };
}

export function mergeMissingTurnStats(
  settled: TurnStatsData,
  live: TurnStatsData
): TurnStatsData {
  return {
    ...settled,
    model: settled.model ?? live.model ?? null,
    totalTokens: settled.totalTokens ?? live.totalTokens ?? null,
    contextWindow: settled.contextWindow ?? live.contextWindow ?? null,
  };
}

function InlineTimelineSideRow({
  entry,
  onRespondQuestion,
  respondingQuestionId,
}: {
  entry: TimelineRow;
  onRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void;
  respondingQuestionId: string | null;
}) {
  const row = entry.row;
  if (row.kind === 'question_request') {
    return (
      <QuestionRequestCard
        request={row.request}
        response={row.response ?? null}
        onRespond={onRespondQuestion}
        responding={respondingQuestionId === row.request.question_id}
      />
    );
  }
  if (row.kind === 'feedback_request') {
    return (
      <div className="rounded-md border border-violet-300/50 bg-violet-50 px-3 py-2 text-xs text-violet-950 dark:border-violet-500/30 dark:bg-violet-950/25 dark:text-violet-100">
        <div className="font-medium">Feedback requested</div>
        <div className="mt-1 whitespace-pre-wrap break-words text-violet-800/80 dark:text-violet-100/75">
          {row.request.prompt}
        </div>
      </div>
    );
  }
  if (row.kind === 'terminal_summary') {
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">
          {row.terminal.command ?? 'Terminal'} · {row.terminal.status}
        </div>
        {row.terminal.output_summary ? (
          <div className="mt-1 whitespace-pre-wrap break-words">
            {row.terminal.output_summary}
          </div>
        ) : null}
      </div>
    );
  }
  if (row.kind === 'artifact_revision') {
    return <ArtifactTimelineCard artifact={row.artifact} />;
  }
  if (row.kind === 'session_notice' && isDurableHostNote(entry)) {
    return (
      <div className="conv-entry-item px-4 py-1">
        <div className="conv-compact-notice whitespace-pre-wrap break-words text-[var(--text-primary)]">
          <div className="text-xs text-[var(--text-muted)]">
            {row.notice.title}
          </div>
          {row.notice.message ? <div>{row.notice.message}</div> : null}
        </div>
      </div>
    );
  }
  return null;
}

/**
 * Conversation view backed by the canonical VibeX event log: projected timeline
 * rows are hydrated from storage and updated from `conversation-events`, then
 * rendered turn-by-turn via {@link MessageTurnView}.
 *
 * Inline turn stats are intentionally absent — token/usage surfaces move out of
 * the timeline in the relocation phase. VibeX-authored.
 */
const AgentTimelineConversation = forwardRef<
  VirtualizedListRef,
  AgentTimelineConversationProps
>(function AgentTimelineConversation(
  { attempt, task, onAtBottomChange, widthMode = 'bounded' },
  ref
) {
  const { t } = useTranslation(['panels', 'conversation', 'common', 'tasks']);
  const { openSurfaceMenu } = useAppContextMenu();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { config } = useUserSystem();
  const { collapseAiMessages: collapseProcess, expandFileChanges } =
    resolveConversationCollapsePreferences(config);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const scrollBehavior: ScrollBehavior = prefersReducedMotion
    ? 'auto'
    : 'smooth';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const [surfaceActive, setSurfaceActive] = useState(true);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let seenVisible = false;
    let active = true;
    const apply = (intersecting: boolean) => {
      const next = nextSurfaceActive({
        active,
        intersecting,
        visibilityState: document.visibilityState,
        seenVisible,
      });
      seenVisible = next.seenVisible;
      if (next.active === active) return;
      active = next.active;
      setSurfaceActive(next.active);
    };
    const observer = new IntersectionObserver(
      ([entry]) => apply(entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(el);
    const onVisibility = () => {
      apply(el.getClientRects().length > 0);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isAtBottomRef = useRef(true);
  const openSettlePassesRef = useRef(CONVERSATION_OPEN_SETTLE_PASSES);
  const followTailRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollDepthRef = useRef(0);
  const smoothFollowRef = useRef(false);
  const seenExpansionRef = useRef<number | null>(null);
  const expansionInViewRef = useRef(false);

  const sessionId = attempt.session?.id ?? null;
  const sessionPinRef = useRef(sessionId);
  const previousPrependEpochRef = useRef(0);
  const previousTotalSizeRef = useRef(0);
  // Absolute workspace root for resolving clickable file paths in messages.
  // Non-worktree workspaces leave container_ref null, so fall back to the repo
  // path — otherwise a relative "README.md" can't be opened in a preview tab.
  const { repos } = useAttemptRepo(attempt.id);
  const workspaceRoot = attempt.container_ref ?? repos[0]?.path ?? null;
  const conversation = useConversationTimeline(sessionId, {
    active: surfaceActive,
  });
  const kanbanSessions = useOptionalKanbanSessionContext();
  const forkSupported = conversation.forkSessionSupported;
  const conversationStatus = useOptionalConversationStatus();
  const setConversationStatusNotices = conversationStatus?.setNotices;
  const setSessionBindReady = conversationStatus?.setSessionBindReady;
  const setConversationStatusQuestion = conversationStatus?.setQuestion;
  const setConversationStatusPermissions = conversationStatus?.setPermissions;
  const setConversationChildrenDock = conversationStatus?.setChildrenDock;
  const usesComposerStatusDock = conversationStatus?.enabled ?? false;
  const timeline = conversation.timeline;
  const isTurnInFlight = useMemo(
    () => isTimelineTurnInFlight(timeline),
    [timeline]
  );
  const detailLoading = conversation.loading;
  const conversationError = conversation.error;
  const sideRows = conversation.sideRows;
  const delegations = useMemo(
    () =>
      sideRows.flatMap((row) =>
        row.row.kind === 'delegation' ? [row.row.delegation] : []
      ),
    [sideRows]
  );
  const timelineQuestions = useMemo(
    () =>
      sideRows.flatMap((row) =>
        row.row.kind === 'question_request'
          ? [
              {
                request: row.row.request,
                response: row.row.response ?? null,
              },
            ]
          : []
      ),
    [sideRows]
  );
  const timelineItems = useMemo(
    () =>
      conversation.items.filter((item) => {
        if (item.kind !== 'side') return true;
        const kind = item.row.row.kind;
        if (
          kind === 'permission_request' ||
          kind === 'turn_error' ||
          kind === 'file_change_summary'
        ) {
          return false;
        }
        if (kind === 'delegation') {
          return false;
        }
        if (kind === 'session_notice' && !isDurableHostNote(item.row)) {
          return false;
        }
        if (
          usesComposerStatusDock &&
          item.row.row.kind === 'question_request' &&
          !item.row.row.response
        ) {
          return false;
        }
        return true;
      }),
    [conversation.items, usesComposerStatusDock]
  );
  useEffect(() => {
    if (conversationError) toast.error(conversationError);
  }, [conversationError]);
  useEffect(() => {
    setSessionBindReady?.(conversation.sessionBindReady);
  }, [conversation.sessionBindReady, setSessionBindReady]);
  // Stable reference (memoized in the hook) for the reset-to-here retry flow.
  const conversationResetAndReload = conversation.resetAndReload;
  // Restore a failed ACP connection without clearing the durable/live timeline.
  const conversationReconnectAndReload = conversation.reconnectAndReload;
  const conversationRebindSession = useCallback(async () => {
    if (!sessionId) return;
    await conversationApi.rebindSession(sessionId);
    await conversationResetAndReload();
  }, [conversationResetAndReload, sessionId]);
  // Stable reference for answering permission requests inline.
  const conversationRespondPermission = conversation.respondPermission;
  const [respondingPermissionId, setRespondingPermissionId] = useState<
    string | null
  >(null);
  const handleRespondPermission = useCallback(
    (permissionId: string, response: AgentPermissionResponse) => {
      setRespondingPermissionId(permissionId);
      void conversationRespondPermission(permissionId, response)
        .catch((error: unknown) => toast.error(getErrorMessage(error)))
        .finally(() =>
          setRespondingPermissionId((current) =>
            current === permissionId ? null : current
          )
        );
    },
    [conversationRespondPermission]
  );
  // Stable reference for answering agent questions (ACP elicitations) inline.
  const conversationRespondQuestion = conversation.respondQuestion;
  const [respondingQuestionId, setRespondingQuestionId] = useState<
    string | null
  >(null);
  const handleRespondQuestion = useCallback(
    (questionId: string, response: AgentElicitationResponse) => {
      setRespondingQuestionId(questionId);
      void conversationRespondQuestion(questionId, response)
        .catch((error: unknown) => toast.error(getErrorMessage(error)))
        .finally(() =>
          setRespondingQuestionId((current) =>
            current === questionId ? null : current
          )
        );
    },
    [conversationRespondQuestion]
  );
  const pendingQuestionRow = useMemo(
    () =>
      sideRows
        .filter(
          (entry) =>
            entry.row.kind === 'question_request' && !entry.row.response
        )
        .at(-1),
    [sideRows]
  );
  const composerQuestion = useMemo(() => {
    if (
      !usesComposerStatusDock ||
      pendingQuestionRow?.row.kind !== 'question_request'
    ) {
      return null;
    }
    return {
      request: pendingQuestionRow.row.request,
      responding:
        respondingQuestionId === pendingQuestionRow.row.request.question_id,
      onRespond: handleRespondQuestion,
    };
  }, [
    handleRespondQuestion,
    pendingQuestionRow,
    respondingQuestionId,
    usesComposerStatusDock,
  ]);
  const isEditorAreaVisible = useLayoutStore(
    (state) => state.isEditorAreaVisible
  );
  const [childStack, setChildStack] = useState<string[]>([]);
  const handleOpenChild = useCallback((childConversationId: string) => {
    setChildStack((stack) =>
      appendChildConversationStack(stack, childConversationId)
    );
  }, []);
  const handleCloseChild = useCallback(() => {
    setChildStack((stack) => popChildConversationStack(stack));
  }, []);

  useEffect(() => {
    if (
      !usesComposerStatusDock ||
      !sessionId ||
      attempt.session?.executor === 'workflow'
    ) {
      setConversationChildrenDock?.(null);
      return;
    }
    setConversationChildrenDock?.({
      conversationId: sessionId,
      onOpenChild: handleOpenChild,
    });
    return () => setConversationChildrenDock?.(null);
  }, [
    attempt.session?.executor,
    handleOpenChild,
    sessionId,
    setConversationChildrenDock,
    usesComposerStatusDock,
  ]);
  // Read the composer's live profile selection so resend stays same-source.
  const { getActiveExecutorProfile } = useActiveExecutorProfile();
  // Keep the latest turn error in full (message + the agent's real ACP error
  // code) so the card can offer code-specific recovery instead of a flat banner.
  const latestTurnErrorRow = sideRows
    .filter((entry) => entry.row.kind === 'turn_error')
    .at(-1);
  const latestTurnError =
    latestTurnErrorRow?.row.kind === 'turn_error'
      ? latestTurnErrorRow.row.error.error
      : null;
  const turnIdsWithErrors = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of sideRows) {
      if (entry.row.kind !== 'turn_error') continue;
      const turnId = entry.row.error.turn_id;
      if (turnId) ids.add(turnId);
    }
    return ids;
  }, [sideRows]);
  const sessionNoticeRows = sideRows.filter(
    (entry) => entry.row.kind === 'session_notice'
  );
  const reconnectNoticeRow = sessionNoticeRows.find(
    (entry) => entry.row_id === AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID
  );
  const connectErrorNoticeRow = sessionNoticeRows.find(
    (entry) => entry.row_id === AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID
  );
  const autoPermissionNoticeRow = sessionNoticeRows.find(
    (entry) => entry.row_id === AUTO_PERMISSION_NOTICE_ROW_ID
  );
  const latestSessionNoticeRow = [...sessionNoticeRows]
    .reverse()
    .find((entry) => !isDurableHostNote(entry));
  const hasReconnectNotice = Boolean(reconnectNoticeRow);

  // Feed the composer's context-usage ring (EntriesContext). The setter is
  // stable, and useOptionalEntries no-ops outside a provider (e.g. logs panel).
  const entries = useOptionalEntries();
  const setTokenUsageInfo = entries?.setTokenUsageInfo;
  const composerTokenUsage = useMemo(
    () => latestTokenUsage(timeline),
    [timeline]
  );
  useEffect(() => {
    setTokenUsageInfo?.(composerTokenUsage);
  }, [setTokenUsageInfo, composerTokenUsage]);

  // Feed the composer's mode picker with the agent-advertised session modes for
  // this conversation (same EntriesContext bridge as the usage ring).
  const setSessionModes = entries?.setSessionModes;
  const conversationSessionModes = conversation.sessionModes;
  useEffect(() => {
    setSessionModes?.(conversationSessionModes);
  }, [setSessionModes, conversationSessionModes]);

  // Same bridge for the agent-advertised config options (model / permission
  // mode / …) so the composer renders live ACP selectors, not static presets.
  const setSessionConfigOptions = entries?.setSessionConfigOptions;
  const conversationSessionConfigOptions = conversation.sessionConfigOptions;
  useEffect(() => {
    setSessionConfigOptions?.(conversationSessionConfigOptions);
  }, [setSessionConfigOptions, conversationSessionConfigOptions]);
  const sessionAgentType = (attempt.session?.agent_id ??
    attempt.session?.executor) as AgentKind | null;
  useEffect(() => {
    if (
      !sessionAgentType ||
      (conversationSessionModes.modes.length === 0 &&
        conversationSessionConfigOptions.length === 0)
    ) {
      return;
    }
    publishLiveSessionControls(queryClient, {
      agentType: sessionAgentType,
      workspaceId: attempt.id,
      controls: {
        modes: conversationSessionModes.modes,
        current_mode: conversationSessionModes.current,
        config_options: conversationSessionConfigOptions,
      },
    });
  }, [
    attempt.id,
    conversationSessionConfigOptions,
    conversationSessionModes,
    queryClient,
    sessionAgentType,
  ]);

  // Canonical turn state and Plan blocks drive the composer even when the
  // legacy process stream has not caught up yet.
  const setConversationPlanEntries = entries?.setConversationPlanEntries;
  const setConversationTurnInFlight = entries?.setConversationTurnInFlight;
  const setConversationSteeringTurnId = entries?.setConversationSteeringTurnId;
  const setConversationDeliveryChannel =
    entries?.setConversationDeliveryChannel;
  const conversationPlanEntries = useMemo(
    () => getLatestTimelinePlanEntries(timeline),
    [timeline]
  );
  useEffect(() => {
    setConversationPlanEntries?.(conversationPlanEntries);
  }, [conversationPlanEntries, setConversationPlanEntries]);
  useEffect(() => {
    setConversationTurnInFlight?.(isTurnInFlight);
  }, [isTurnInFlight, setConversationTurnInFlight]);
  useEffect(() => {
    setConversationSteeringTurnId?.(
      getComposerSteeringTarget({
        isTurnInFlight,
        steeringSupported: conversation.steeringSupported,
        currentTurnId: conversation.currentTurnId,
      })?.turnId ?? null
    );
  }, [
    conversation.currentTurnId,
    conversation.steeringSupported,
    isTurnInFlight,
    setConversationSteeringTurnId,
  ]);
  useEffect(() => {
    setConversationDeliveryChannel?.(conversation.deliveryChannel);
  }, [conversation.deliveryChannel, setConversationDeliveryChannel]);

  const setUserMessageHistory = entries?.setUserMessageHistory;
  const timelineTurns = useMemo(
    () => timeline.map((row) => row.turn),
    [timeline]
  );
  const contextCompactByRowKey = useMemo(
    () => buildContextCompactPresentationByRowKey(timeline),
    [timeline]
  );
  const composerUserMessageHistory = useMemo(
    () =>
      composerMessageHistoryFromTurns(timelineTurns, isContextCompactPrompt),
    [timelineTurns]
  );
  useEffect(() => {
    setUserMessageHistory?.(composerUserMessageHistory);
  }, [composerUserMessageHistory, setUserMessageHistory]);

  const liveStats = useMemo<TurnStatsData>(
    () =>
      buildLiveTurnStats({
        timeline,
        composerTokenUsage,
        sessionConfigOptions: conversationSessionConfigOptions,
      }),
    [composerTokenUsage, conversationSessionConfigOptions, timeline]
  );
  const lastAssistantKey = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const row = timeline[index];
      if (row?.turn.role === 'assistant') return row.key;
    }
    return null;
  }, [timeline]);

  const navEntries = useMemo(
    () => buildTimelineNavEntries(timelineItems),
    [timelineItems]
  );
  const expandableRevision = useExpandableRevision();
  const hideThinking = resolveHideModelThinking(config);
  const virtualEntries = useMemo(
    () =>
      buildTimelineVirtualEntries({
        items: timelineItems,
        collapseProcess,
        hideThinking,
        processExpanded: (turnId, foldStartIndex) =>
          isExpandableOpen(`process:${turnId}:${foldStartIndex}`),
        isContextCompact: (rowKey) => contextCompactByRowKey.has(rowKey),
      }),
    [
      collapseProcess,
      config,
      contextCompactByRowKey,
      expandableRevision,
      hideThinking,
      timelineItems,
    ]
  );
  const userMessageIndexes = useMemo(
    () =>
      virtualEntries.flatMap((entry, index) => {
        const item = timelineItems[entry.timelineIndex];
        return timelineItemAsMessage(item)?.turn.role === 'user' ? [index] : [];
      }),
    [timelineItems, virtualEntries]
  );
  const activeNavEntry = useMemo(
    () => findActiveConversationMessageNavEntry(navEntries, activeIndex),
    [activeIndex, navEntries]
  );

  const runProgrammaticScroll = useCallback((action: () => void) => {
    programmaticScrollDepthRef.current += 1;
    try {
      action();
    } finally {
      queueMicrotask(() => {
        programmaticScrollDepthRef.current = Math.max(
          0,
          programmaticScrollDepthRef.current - 1
        );
      });
    }
  }, []);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualEntries.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_CONVERSATION_ROW_HEIGHT,
    getItemKey: (index) => virtualEntries[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin,
    observeElementRect: observeUnscaledElementRect,
    measureElement: measureUnscaledBlockHeight,
    scrollToFn: (offset, options, instance) => {
      runProgrammaticScroll(() => {
        elementScroll(offset, options, instance);
      });
    },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const jumpToVirtualIndex = useCallback(
    (index: number, align: 'start' | 'center' | 'end' | 'auto' = 'start') => {
      if (index < 0 || index >= virtualEntries.length) return;
      const jump = () => {
        rowVirtualizer.scrollToIndex(index, {
          align,
          behavior: 'auto',
        });
      };
      scheduleMeasuredScrollToIndex(jump, index);
    },
    [rowVirtualizer, virtualEntries.length]
  );

  const conversationHasEarlier = conversation.hasEarlier;
  const conversationLoadOlder = conversation.loadOlder;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchIndex, setFindMatchIndex] = useState(0);
  const findMatches = useMemo(
    () => (findOpen ? findInConversationTimeline(timeline, findQuery) : []),
    [findOpen, findQuery, timeline]
  );
  const currentFindMatch = findMatches[findMatchIndex] ?? null;

  const scrollToFindMatch = useCallback(
    (matchIndex: number) => {
      const match = findMatches[matchIndex];
      if (!match) return;
      const key = timeline[match.rowIndex]?.key;
      if (!key) return;
      const virtualIndex = virtualEntries.findIndex((entry) => {
        const item = timelineItems[entry.timelineIndex];
        return item?.kind === 'message' && item.item.key === key;
      });
      if (virtualIndex < 0) return;
      jumpToVirtualIndex(virtualIndex, 'center');
    },
    [findMatches, jumpToVirtualIndex, timeline, timelineItems, virtualEntries]
  );

  const goToFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (findMatches.length === 0) return;
      setFindMatchIndex((current) => {
        const next =
          (current + direction + findMatches.length) % findMatches.length;
        queueMicrotask(() => scrollToFindMatch(next));
        return next;
      });
    },
    [findMatches.length, scrollToFindMatch]
  );

  useEffect(() => {
    setFindMatchIndex(0);
  }, [findQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFind =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f';
      if (!isFind) return;
      const panel = panelRef.current;
      if (!panel?.contains(document.activeElement)) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const updateAtBottomState = useCallback(() => {
    if (!followTailRef.current) return;
    if (openSettlePassesRef.current > 0) return;
    const container = containerRef.current;
    if (!container) return;
    const next = isConversationNearBottom(container);
    if (isAtBottomRef.current === next) return;
    isAtBottomRef.current = next;
    onAtBottomChange?.(next);
  }, [onAtBottomChange]);

  const updateActiveIndex = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const anchor = findViewportAnchorVirtualIndex(
      rowVirtualizer.getVirtualItems(),
      container.scrollTop,
      container.clientHeight
    );
    const next =
      anchor == null ? null : (virtualEntries[anchor]?.timelineIndex ?? null);
    setActiveIndex((current) => (current === next ? current : next));
  }, [rowVirtualizer, virtualEntries]);

  const detachFromBottom = useCallback(() => {
    cancelVirtualizerFollowScroll(rowVirtualizer);
    const container = containerRef.current;
    if (container && smoothFollowRef.current) {
      smoothFollowRef.current = false;
      runProgrammaticScroll(() => {
        container.scrollTo({ top: container.scrollTop, behavior: 'auto' });
      });
    }
    followTailRef.current = false;
    openSettlePassesRef.current = 0;
    if (!isAtBottomRef.current) return;
    isAtBottomRef.current = false;
    onAtBottomChange?.(false);
  }, [onAtBottomChange, rowVirtualizer, runProgrammaticScroll]);

  const pinToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      smoothFollowRef.current = behavior === 'smooth';
      cancelVirtualizerFollowScroll(rowVirtualizer);
      runProgrammaticScroll(() => {
        const top = container.scrollHeight;
        if (behavior === 'smooth') {
          container.scrollTo({ top, behavior });
        } else {
          container.scrollTop = top;
        }
      });
      lastScrollTopRef.current = container.scrollTop;
    },
    [rowVirtualizer, runProgrammaticScroll]
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      followTailRef.current = true;
      openSettlePassesRef.current = 0;
      isAtBottomRef.current = true;
      onAtBottomChange?.(true);
      pinToBottom(behavior);
    },
    [onAtBottomChange, pinToBottom]
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const previous = lastScrollTopRef.current;
      const scrollTop = container.scrollTop;
      lastScrollTopRef.current = scrollTop;
      const intent = conversationFollowIntent({
        trustedUserScroll:
          event.nativeEvent.isTrusted &&
          programmaticScrollDepthRef.current === 0,
        previousScrollTop: previous,
        scrollTop,
        nearBottom: isConversationNearBottom(container),
        attached: followTailRef.current,
      });
      if (intent === 'detach') {
        detachFromBottom();
      } else if (intent === 'attach') {
        followTailRef.current = true;
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
      if (
        event.nativeEvent.isTrusted &&
        programmaticScrollDepthRef.current === 0 &&
        shouldLoadOlderTimelinePage({
          hasEarlier: conversationHasEarlier,
          isAtBottom: isAtBottomRef.current,
          scrollTop,
          previousScrollTop: previous,
        })
      ) {
        void conversationLoadOlder();
      }
      updateAtBottomState();
      updateActiveIndex();
    },
    [
      conversationHasEarlier,
      conversationLoadOlder,
      detachFromBottom,
      onAtBottomChange,
      updateActiveIndex,
      updateAtBottomState,
    ]
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      const virtualIndex = virtualEntries.findIndex(
        (entry) => entry.timelineIndex === index
      );
      if (virtualIndex < 0) return;
      detachFromBottom();
      jumpToVirtualIndex(virtualIndex, 'start');
      setActiveIndex(index);
    },
    [detachFromBottom, jumpToVirtualIndex, virtualEntries]
  );

  const updateScrollMargin = useCallback(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    const next = measureScrollMargin(list, container);
    setScrollMargin((current) =>
      Math.abs(current - next) > 1 ? next : current
    );
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    updateScrollMargin();
    const observer = new ResizeObserver(() => updateScrollMargin());
    observer.observe(container);
    observer.observe(list);
    return () => observer.disconnect();
  }, [sideRows.length, updateScrollMargin]);

  useLayoutEffect(() => {
    updateActiveIndex();
  }, [updateActiveIndex, virtualRows]);

  // Pin scrollTop while the tail is followed. scrollToIndex starts TanStack's
  // reconcile loop, which repeats the scroll for as long as the last row grows.
  useLayoutEffect(() => {
    const sessionChanged = sessionPinRef.current !== sessionId;
    const prepended =
      conversation.olderTurnsPrependEpoch > previousPrependEpochRef.current;
    const container = containerRef.current;
    if (container) {
      const nextTop = scrollTopAfterPrepend({
        followTail: followTailRef.current,
        sessionChanged,
        prepended,
        previousTotalSize: previousTotalSizeRef.current,
        nextTotalSize: totalSize,
        scrollTop: container.scrollTop,
      });
      if (nextTop !== container.scrollTop) {
        runProgrammaticScroll(() => {
          container.scrollTop = nextTop;
        });
      }
    }
    previousPrependEpochRef.current = conversation.olderTurnsPrependEpoch;
    previousTotalSizeRef.current = totalSize;
    sessionPinRef.current = sessionId;
    const expansionChanged =
      expansionInViewRef.current &&
      seenExpansionRef.current !== null &&
      seenExpansionRef.current !== expandableRevision;
    expansionInViewRef.current = false;
    seenExpansionRef.current = expandableRevision;
    const decision = conversationTailFollowAction({
      attached: followTailRef.current,
      sessionChanged,
      expansionChanged,
      settlePassesRemaining: openSettlePassesRef.current,
      itemCount: virtualEntries.length,
      nearBottom: isAtBottomRef.current,
    });
    followTailRef.current = decision.attached;
    openSettlePassesRef.current = decision.settlePassesRemaining;
    if (decision.action === 'release') {
      if (expansionChanged) {
        detachFromBottom();
      } else {
        cancelVirtualizerFollowScroll(rowVirtualizer);
        if (isAtBottomRef.current && !decision.attached) {
          isAtBottomRef.current = false;
          onAtBottomChange?.(false);
        }
      }
      return;
    }
    if (virtualEntries.length === 0) {
      if (!isAtBottomRef.current) {
        isAtBottomRef.current = true;
        onAtBottomChange?.(true);
      }
      return;
    }
    isAtBottomRef.current = true;
    onAtBottomChange?.(true);
    pinToBottom('auto');
  }, [
    detachFromBottom,
    expandableRevision,
    onAtBottomChange,
    pinToBottom,
    rowVirtualizer,
    runProgrammaticScroll,
    conversation.olderTurnsPrependEpoch,
    sessionId,
    totalSize,
    virtualEntries.length,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom() {
        scrollToBottom(scrollBehavior);
      },
      scrollToIndex(index, options) {
        const virtualIndex = virtualEntries.findIndex(
          (entry) => entry.timelineIndex === index
        );
        if (virtualIndex < 0) return;
        if ((options?.behavior ?? scrollBehavior) === 'smooth') {
          detachFromBottom();
        }
        jumpToVirtualIndex(virtualIndex, options?.align ?? 'center');
      },
      scrollToPreviousUserMessage() {
        const container = containerRef.current;
        if (!container) return;
        const anchor = findViewportAnchorVirtualIndex(
          rowVirtualizer.getVirtualItems(),
          container.scrollTop,
          container.clientHeight
        );
        const target = findPreviousUserMessageVirtualIndex(
          userMessageIndexes,
          anchor
        );
        if (target === null) return;
        detachFromBottom();
        jumpToVirtualIndex(target, 'center');
      },
    }),
    [
      detachFromBottom,
      jumpToVirtualIndex,
      rowVirtualizer,
      scrollBehavior,
      scrollToBottom,
      userMessageIndexes,
      virtualEntries,
    ]
  );

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    return bindConversationSummaryMarquee(root);
  }, []);

  // Inline turn stats are sourced from the parsed MessageTurn / live usage.
  const handleForkFromTurn = useCallback(
    async (turnId?: string) => {
      if (!sessionId) return;
      try {
        const result = await conversationApi.fork(sessionId, turnId);
        if (result.continuity === 'history_only') {
          toast.warning(
            t('tasks:hubListItem.forkHistoryOnly', {
              reason: result.continuityNote,
            })
          );
        }
        kanbanSessions?.placeForkedChild(
          {
            sessionId: result.conversationId,
            workspaceId: attempt.id,
          },
          sessionId
        );
      } catch (error) {
        toast.error(
          t('tasks:hubListItem.forkFailed', {
            error: getErrorMessage(error),
          })
        );
      }
    },
    [attempt.id, kanbanSessions, sessionId, t]
  );

  const renderTurnStats = useCallback(
    (row: ConversationTimelineTurn, index: number) => {
      if (row.turn.role !== 'assistant') return null;
      const jumpTarget = findPreviousUserMessageVirtualIndex(
        userMessageIndexes,
        index
      );
      const onJumpBack =
        jumpTarget === null
          ? null
          : () => {
              detachFromBottom();
              jumpToVirtualIndex(jumpTarget, 'center');
            };
      const copyText = assistantCopyText(row.turn);
      const vibexTurnId = vibexTurnIdFromTimelineRowId(row.turn.id);
      const forkPointStatus = row.forkPointStatus ?? null;
      const canOfferFork = forkSupported && forkPointStatus !== 'unsupported';
      const forkDisabledReason =
        forkPointStatus === 'unnamed' || row.phase === 'streaming'
          ? 'unnamed'
          : 'busy';
      const forkDisabled =
        isTurnInFlight ||
        forkPointStatus === 'unnamed' ||
        row.phase === 'streaming' ||
        row.phase === 'optimistic';
      const onForkFromHere = canOfferFork
        ? () => {
            void handleForkFromTurn(vibexTurnId);
          }
        : null;
      const settled = buildSettledTurnStats(row.turn);
      const stats =
        row.key === lastAssistantKey
          ? mergeMissingTurnStats(settled, liveStats)
          : settled;
      return row.phase === 'streaming' && !hasReconnectNotice ? (
        <LiveTurnStats
          stats={liveStats}
          startedAt={row.turn.timestamp}
          copyText={copyText}
          onJumpBack={onJumpBack}
        />
      ) : (
        <TurnStats
          stats={stats}
          copyText={copyText}
          onJumpBack={onJumpBack}
          onForkFromHere={onForkFromHere}
          forkDisabled={forkDisabled}
          forkDisabledReason={forkDisabledReason}
        />
      );
    },
    [
      detachFromBottom,
      forkSupported,
      handleForkFromTurn,
      hasReconnectNotice,
      isTurnInFlight,
      jumpToVirtualIndex,
      lastAssistantKey,
      liveStats,
      userMessageIndexes,
    ]
  );

  // The Nth user turn maps to the Nth checkpoint ordinal (see G-R1).
  const userOrdinalByKey = useMemo(() => {
    const map = new Map<string, number>();
    let ordinal = 0;
    for (const item of timelineItems) {
      const row = timelineItemAsMessage(item);
      if (row?.turn.role === 'user') {
        map.set(row.key, ordinal);
        ordinal += 1;
      }
    }
    return map;
  }, [timelineItems]);
  const lastUserRowKey = navEntries.at(-1)?.key ?? null;
  const latestInterruptedRow = useMemo(() => {
    const latestRow = [...timeline]
      .reverse()
      .find((row) => row.turn.role === 'user');
    return latestRow?.phase === 'interrupted' ? latestRow : null;
  }, [timeline]);

  // Same ordinal keyed by turn id (message rows are `${turnId}:user`), for the
  // per-turn files-changed Undo which rolls back to that turn's checkpoint.
  const userOrdinalByTurnId = useMemo(() => {
    const map = new Map<string, number>();
    let ordinal = 0;
    for (const row of timeline) {
      if (row.turn.role === 'user') {
        map.set(row.turn.id.replace(/:user$/, ''), ordinal);
        ordinal += 1;
      }
    }
    return map;
  }, [timeline]);

  // Latest checkpoint-diff summary per turn, rendered inline at the end of the
  // turn that produced it (rows without a turn_id stay hidden rather than
  // resurfacing as a detached header block).
  const fileChangesByTurnId = useMemo(() => {
    const map = new Map<
      string,
      Extract<TimelineRow['row'], { kind: 'file_change_summary' }>
    >();
    for (const entry of sideRows) {
      if (entry.row.kind !== 'file_change_summary') continue;
      if (!entry.row.turn_id) continue;
      map.set(entry.row.turn_id, entry.row);
    }
    return map;
  }, [sideRows]);

  // Unanswered permission requests dock at the bottom of the stream (above the
  // composer) instead of scrolling away with the timeline; answered ones are
  // already reflected by their tool calls, so they are not re-rendered.
  const pendingPermissions = useMemo(
    () =>
      sideRows.flatMap((entry) =>
        entry.row.kind === 'permission_request' &&
        entry.row.request.status === 'pending'
          ? [entry.row.request]
          : []
      ),
    [sideRows]
  );

  const handleUndoTurnChanges = useCallback(
    async (turnId: string) => {
      const session = attempt.session;
      const ordinal = userOrdinalByTurnId.get(turnId);
      if (!session || ordinal === undefined) return;

      const choice = await ConfirmDialog.show({
        title: t('conversation:turnFileChanges.undoConfirmTitle'),
        message: t('conversation:turnFileChanges.undoConfirmMessage'),
        confirmText: t('conversation:turnFileChanges.undoConfirm'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (choice !== 'confirmed') return;

      try {
        await agentsApi.resetToCheckpoint(session.id, ordinal, true, false);
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [attempt.session, t, userOrdinalByTurnId]
  );

  const handleRetry = useCallback(
    async (
      turn: MessageTurn,
      ordinal: number,
      replacementText?: string
    ): Promise<boolean> => {
      const session = attempt.session;
      if (!session?.executor) return false;
      const text =
        replacementText ??
        turn.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n\n');
      if (!text) return false;

      let rollbackFiles: ConversationFileChange[] = [];
      let previewUnavailable = false;
      try {
        const preview = await loadResendCheckpointPreview(() =>
          conversationApi.previewCheckpointFileChanges({
            conversationId: session.id,
            ordinal,
          })
        );
        rollbackFiles = preview.files;
        previewUnavailable = preview.previewUnavailable;
      } catch (error) {
        previewUnavailable = true;
        console.warn('checkpoint preview unavailable', error);
      }

      let restoreFiles = false;
      if (
        !previewUnavailable &&
        shouldConfirmResendCheckpoint({
          files: rollbackFiles,
          previewUnavailable: false,
        })
      ) {
        const choice = await ResendCheckpointDialog.show({
          title: t('timeline.resendMessageTitle'),
          files: rollbackFiles,
          previewUnavailable,
        });
        if (choice === 'dismissed') return false;
        restoreFiles = choice === 'restore';
      }

      try {
        // Optional workspace rollback first — it relies on the checkpoint recorded
        // at this ordinal, which the truncation below then removes.
        if (restoreFiles) {
          try {
            await agentsApi.resetToCheckpoint(session.id, ordinal, true, false);
          } catch (error) {
            // No checkpoint at this ordinal (e.g. a pre-feature turn) -> resend only.
            console.warn('checkpoint restore skipped', error);
          }
        }

        // Truncate the durable conversation to before this turn (events/turns/
        // checkpoints + projection), then hard-reset the frontend so it re-projects
        // the truncated timeline before the resend's live events arrive.
        await conversationApi.truncateToTurn({
          conversationId: session.id,
          ordinal,
        });
        await conversationResetAndReload();
        await conversationApi.ensureSessionControls(session.id, {
          reload: false,
        });

        // Resend with the composer's live profile (model/variant/reasoning) instead
        // of a bare `{ executor, variant: null }`, which the backend would resolve
        // to the agent's DEFAULT profile and silently override the user's choice
        // (the Codex gpt-5.3-codex resend regression).
        await sendAgentRuntimeTurn({
          workspaceId: attempt.id,
          sessionId: session.id,
          executorProfileId: resolveResendExecutorProfile(
            getActiveExecutorProfile(),
            session.executor as AgentKind
          ),
          text,
        });
        return true;
      } catch (error) {
        toast.error(getErrorMessage(error));
        return false;
      }
    },
    [
      attempt.id,
      attempt.session,
      conversationResetAndReload,
      getActiveExecutorProfile,
      t,
    ]
  );

  const statusNotices = useMemo(() => {
    const notices: ConversationStatusNotice[] = [];
    const pushSessionNotice = (
      row:
        | (typeof sessionNoticeRows)[number]
        | typeof latestSessionNoticeRow
        | undefined
    ) => {
      if (!row || row.row.kind !== 'session_notice' || !row.row.notice) return;
      if (isResendColdStartNotice(row.row_id, row.row.notice)) return;
      if (notices.some((notice) => notice.id === row.row_id)) return;
      const notice = row.row.notice;
      notices.push({
        id: row.row_id,
        kind: 'session-notice' as const,
        notice,
        onRebind: sessionNoticeNeedsRebind(notice, row.row_id)
          ? conversationRebindSession
          : undefined,
        onReload:
          row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
            ? conversationReconnectAndReload
            : undefined,
        onNewConversation:
          row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
            ? () =>
                requestCreateSessionInExecutionArea(
                  setSearchParams,
                  searchParams
                )
            : undefined,
      });
    };
    if (latestTurnError && latestTurnErrorRow) {
      notices.push({
        id: latestTurnErrorRow.row_id,
        kind: 'turn-error' as const,
        error: latestTurnError,
        onReload: conversationReconnectAndReload,
        onRebind: conversationRebindSession,
      });
    } else {
      pushSessionNotice(connectErrorNoticeRow);
    }
    pushSessionNotice(reconnectNoticeRow);
    pushSessionNotice(autoPermissionNoticeRow);
    if (latestInterruptedRow) {
      notices.push({
        id: latestInterruptedRow.key,
        kind: 'interrupted-turn' as const,
        onResend: () =>
          void handleRetry(
            latestInterruptedRow.turn,
            userOrdinalByKey.get(latestInterruptedRow.key) ?? 0
          ),
      });
    }
    if (
      latestSessionNoticeRow?.row_id !== reconnectNoticeRow?.row_id &&
      latestSessionNoticeRow?.row_id !== connectErrorNoticeRow?.row_id &&
      latestSessionNoticeRow?.row_id !== autoPermissionNoticeRow?.row_id
    ) {
      pushSessionNotice(latestSessionNoticeRow);
    }
    return notices;
  }, [
    autoPermissionNoticeRow,
    connectErrorNoticeRow,
    conversationReconnectAndReload,
    conversationRebindSession,
    handleRetry,
    latestInterruptedRow,
    latestSessionNoticeRow,
    latestTurnError,
    latestTurnErrorRow,
    reconnectNoticeRow,
    searchParams,
    setSearchParams,
    userOrdinalByKey,
  ]);

  useEffect(() => {
    if (!usesComposerStatusDock) {
      setConversationStatusNotices?.([]);
      return;
    }
    setConversationStatusNotices?.(statusNotices);
  }, [setConversationStatusNotices, statusNotices, usesComposerStatusDock]);

  useEffect(() => {
    setConversationStatusQuestion?.(composerQuestion);
    return () => setConversationStatusQuestion?.(null);
  }, [composerQuestion, setConversationStatusQuestion]);

  const composerPermissions = useMemo(() => {
    if (!usesComposerStatusDock) return [];
    return pendingPermissions.map((request) => ({
      request,
      responding: respondingPermissionId === request.permission_id,
      onRespond: handleRespondPermission,
    }));
  }, [
    handleRespondPermission,
    pendingPermissions,
    respondingPermissionId,
    usesComposerStatusDock,
  ]);

  useEffect(() => {
    setConversationStatusPermissions?.(composerPermissions);
    return () => setConversationStatusPermissions?.([]);
  }, [composerPermissions, setConversationStatusPermissions]);

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col">
      {findOpen ? (
        <ConversationFindBar
          query={findQuery}
          current={findMatches.length === 0 ? 0 : findMatchIndex + 1}
          total={findMatches.length}
          onQueryChange={setFindQuery}
          onNext={() => goToFindMatch(1)}
          onPrevious={() => goToFindMatch(-1)}
          onClose={() => {
            setFindOpen(false);
            setFindQuery('');
            setFindMatchIndex(0);
          }}
        />
      ) : null}
      <ConversationSelectionToolbar
        rootRef={containerRef}
        conversationId={sessionId}
      />
      <PiProjectTrustBanner
        agentId={attempt.session?.agent_id ?? attempt.session?.executor}
        workingDir={workspaceRoot}
        turnInFlight={isTurnInFlight}
      />
      <div
        ref={containerRef}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-2 py-3',
          !usesComposerStatusDock && 'pb-14'
        )}
        data-panel="conversation-logs"
        onScroll={handleScroll}
        onClickCapture={(event) => {
          if (isConversationExpansionToggle(event.target)) {
            expansionInViewRef.current = true;
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (isConversationExpansionToggle(event.target)) {
            expansionInViewRef.current = true;
          }
        }}
        onWheel={(event) => {
          if (wheelDetachesConversationFollow(event.deltaY)) {
            detachFromBottom();
          }
        }}
        onContextMenu={(event) => {
          const rowEl = (event.target as HTMLElement | null)?.closest(
            '[data-index]'
          );
          const index = rowEl
            ? Number(rowEl.getAttribute('data-index'))
            : Number.NaN;
          const virtualEntry = Number.isFinite(index)
            ? virtualEntries[index]
            : null;
          const item = virtualEntry
            ? timelineItems[virtualEntry.timelineIndex]
            : null;
          const row = item?.kind === 'message' ? item.item : null;
          const items: ProductContextMenuItem[] = [];
          if (row) {
            const copyText = turnCopyText(row.turn);
            if (copyText) {
              items.push({
                id: 'copy-turn',
                label: t('common:contextMenu.copy'),
                onSelect: () => {
                  void writeClipboardViaBridge(copyText);
                },
              });
            }
            const turnId = vibexTurnIdFromTimelineRowId(row.turn.id);
            const forkPointStatus = row.forkPointStatus ?? null;
            const canOfferFork =
              forkSupported && forkPointStatus !== 'unsupported';
            items.push({
              id: 'fork-from-here',
              label: t('common:contextMenu.forkFromHere'),
              disabled:
                !canOfferFork ||
                isTurnInFlight ||
                forkPointStatus === 'unnamed' ||
                row.phase === 'streaming' ||
                row.phase === 'optimistic',
              onSelect: () => {
                void handleForkFromTurn(turnId);
              },
            });
            items.push({ type: 'separator', id: 'turn-sep' });
          }
          if (sessionId) {
            const title =
              attempt.session?.name ?? t('tasks:hubListItem.sessionFallback');
            items.push({
              type: 'submenu',
              id: 'export-session',
              label: t('common:contextMenu.exportSession'),
              children: [
                {
                  id: 'export-md',
                  label: t('common:contextMenu.exportMarkdown'),
                  onSelect: () => {
                    void exportConversation(sessionId, 'markdown', title);
                  },
                },
                {
                  id: 'export-html',
                  label: t('common:contextMenu.exportHtml'),
                  onSelect: () => {
                    void exportConversation(sessionId, 'html', title);
                  },
                },
              ],
            });
            items.push({
              id: 'fork-session',
              label: t('common:contextMenu.forkSession'),
              disabled: !forkSupported,
              onSelect: () => {
                void handleForkFromTurn();
              },
            });
            items.push({
              id: 'copy-markdown',
              label: t('common:contextMenu.copyAsMarkdown'),
              onSelect: () => {
                void copyConversationMarkdown(sessionId);
              },
            });
          }
          items.push({
            id: 'create-session',
            label: t('common:contextMenu.createSession'),
            onSelect: () => {
              requestCreateSessionInExecutionArea(
                setSearchParams,
                searchParams
              );
            },
          });
          openSurfaceMenu(event, items);
        }}
      >
        <PluginTimelineCards />
        <div
          className={cn(
            'conv-thread-shell relative mx-auto w-full',
            conversationThreadMaxWidthClass(widthMode, isEditorAreaVisible)
          )}
        >
          {detailLoading && timeline.length === 0 ? (
            <ConversationTimelineSkeleton
              label={t('tasks:sessionConversationView.loadingSession', {
                defaultValue: 'Loading session...',
              })}
            />
          ) : (
            <>
              <SubagentLifecycleProvider turns={timelineTurns}>
                <div className="conv-thread-content min-w-0">
                  {conversation.connecting ? (
                    <div className="mb-2 flex justify-center text-muted-foreground">
                      <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>
                          {t('conversation:statusDock.connectingTitle')}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {attempt.session?.executor === 'workflow' && sessionId ? (
                    <WorkflowRunCard runId={sessionId} />
                  ) : null}

                  {conversation.hasEarlier ? (
                    <div className="mb-3 flex justify-center">
                      <button
                        type="button"
                        className="rounded-full border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground"
                        onClick={() => {
                          void conversation.loadOlder();
                        }}
                      >
                        {t('conversation:timeline.loadEarlier', {
                          defaultValue: '更早的消息',
                        })}
                      </button>
                    </div>
                  ) : null}
                  <TimelineImagePanel>
                    <div
                      ref={virtualListRef}
                      className="relative w-full"
                      style={{ height: `${totalSize}px` }}
                    >
                      {virtualRows.map((virtualRow) => {
                        const entry = virtualEntries[virtualRow.index];
                        if (!entry) return null;
                        const item = timelineItems[entry.timelineIndex];
                        if (!item) return null;
                        const row = item.kind === 'message' ? item.item : null;
                        const isCurrentFindMatch =
                          row != null &&
                          currentFindMatch != null &&
                          timeline[currentFindMatch.rowIndex]?.key === row.key;
                        return (
                          <div
                            key={virtualRow.key}
                            ref={rowVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            className={cn(
                              'absolute left-0 top-0 w-full pb-3',
                              activeNavEntry?.index === entry.timelineIndex &&
                                'conv-message-nav-target-active',
                              isCurrentFindMatch && 'rounded-md bg-primary/10'
                            )}
                            style={{
                              transform: getVirtualRowTranslateY(
                                virtualRow.start,
                                scrollMargin
                              ),
                            }}
                          >
                            {item.kind === 'side' ? (
                              <InlineTimelineSideRow
                                entry={item.row}
                                onRespondQuestion={handleRespondQuestion}
                                respondingQuestionId={respondingQuestionId}
                              />
                            ) : null}
                            {row ? (
                              <MessageTurnView
                                turn={row.turn}
                                phase={row.phase}
                                attempt={attempt}
                                task={task}
                                workspacePath={workspaceRoot}
                                onRetry={
                                  row.turn.role === 'user'
                                    ? () =>
                                        void handleRetry(
                                          row.turn,
                                          userOrdinalByKey.get(row.key) ?? 0
                                        )
                                    : undefined
                                }
                                onEditRetry={
                                  isEditableUserTimelineRow(row, lastUserRowKey)
                                    ? (editedText) =>
                                        handleRetry(
                                          row.turn,
                                          userOrdinalByKey.get(row.key) ?? 0,
                                          editedText
                                        )
                                    : undefined
                                }
                                collapseProcess={collapseProcess}
                                delegations={delegations}
                                questions={timelineQuestions}
                                onOpenChild={handleOpenChild}
                                showInterruptedNotice={false}
                                contextCompact={
                                  contextCompactByRowKey.get(row.key) ?? null
                                }
                                hasTurnError={
                                  turnIdsWithErrors.has(
                                    vibexTurnIdFromTimelineRowId(row.turn.id)
                                  ) || hasReconnectNotice
                                }
                                slice={entry.slice}
                                isLastSlice={entry.isLast}
                              />
                            ) : null}
                            {row?.turn.role === 'assistant' && entry.isLast
                              ? (() => {
                                  const turnId = vibexTurnIdFromTimelineRowId(
                                    row.turn.id
                                  );
                                  const fileChanges =
                                    fileChangesByTurnId.get(turnId);
                                  if (!fileChanges) return null;
                                  return (
                                    <div className="min-w-0 px-4">
                                      <TurnFileChangesCard
                                        summary={fileChanges.summary}
                                        expansionKey={`turn-files:${turnId}`}
                                        defaultExpanded={expandFileChanges}
                                        onUndo={() =>
                                          void handleUndoTurnChanges(turnId)
                                        }
                                        undoDisabled={isTurnInFlight}
                                      />
                                    </div>
                                  );
                                })()
                              : null}
                            {row && entry.isLast
                              ? renderTurnStats(row, virtualRow.index)
                              : null}
                          </div>
                        );
                      })}
                    </div>
                  </TimelineImagePanel>
                  {!usesComposerStatusDock && pendingPermissions.length > 0 ? (
                    <div className="sticky bottom-0 z-10 space-y-2 pt-2">
                      {pendingPermissions.map((request) => (
                        <PermissionRequestCard
                          key={`permission-${request.permission_id}`}
                          request={request}
                          onRespond={handleRespondPermission}
                          responding={
                            respondingPermissionId === request.permission_id
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </SubagentLifecycleProvider>
              <div className="conv-message-nav-anchor">
                <ConversationMessageNav
                  entries={navEntries}
                  activeIndex={activeIndex}
                  onSelect={scrollToIndex}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {!usesComposerStatusDock ? (
        <ConversationStatusDock
          notices={statusNotices}
          dismissalScope={sessionId}
          placement="panel"
          extra={
            sessionId && attempt.session?.executor !== 'workflow' ? (
              <ConversationChildrenSummary
                conversationId={sessionId}
                onOpenChild={handleOpenChild}
              />
            ) : null
          }
        />
      ) : null}
      {childStack.map((childConversationId) => {
        const child = delegations.find(
          (item) => item.child_conversation_id === childConversationId
        );
        return (
          <ChildConversationViewer
            key={childConversationId}
            conversationId={childConversationId}
            agentId={child?.agent_id ?? null}
            taskPreview={child?.task_preview ?? null}
            attempt={attempt}
            task={task}
            workspacePath={workspaceRoot}
            onClose={handleCloseChild}
            onOpenChild={handleOpenChild}
          />
        );
      })}
    </div>
  );
});

export default AgentTimelineConversation;
