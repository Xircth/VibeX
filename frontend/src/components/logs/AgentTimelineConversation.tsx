import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQueryClient } from '@tanstack/react-query';
import { AgentKind } from 'shared/types';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  ConversationFileChange,
  MessageTurn,
  PlanEntry,
  TaskWithAttemptStatus,
  TimelineRow,
  TokenUsageInfo,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { TurnFileChangesCard } from '@/components/NormalizedConversation/TurnFileChangesCard';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { DelegationCard } from '@/components/NormalizedConversation/conversation/DelegationCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { agentsApi } from '@/features/agents/api';
import { publishLiveSessionControls } from '@/features/agents/sessionControlsQuery';
import { conversationApi } from '@/features/conversation/conversationApi';
import { getConversationSessionNoticeCopy } from '@/features/conversation/sessionNoticeCopy';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import { ConfirmDialog } from '@/components/dialogs';
import { ResendCheckpointDialog } from '@/components/dialogs';
import { getErrorMessage } from '@/lib/modals';
import { toast } from '@/components/ui/toast';
import { TurnStats } from '@/components/conversation-thread/TurnStats';
import { LiveTurnStats } from '@/components/conversation-thread/LiveTurnStats';
import type { TurnStatsData } from '@/components/conversation-thread/turnStatsModel';
import { useUserSystem } from '@/components/ConfigProvider';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import {
  findActiveConversationMessageNavEntry,
  type ConversationMessageNavEntry,
} from '@/components/conversation-thread/messageNavEntries';
import { type ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { useOptionalEntries } from '@/contexts/EntriesContext';
import { useOptionalConversationStatus } from '@/contexts/ConversationStatusContext';
import {
  resolveResendExecutorProfile,
  useActiveExecutorProfile,
} from '@/contexts/ActiveExecutorProfileContext';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { paths } from '@/lib/paths';
import { cn } from '@/lib/utils';
import {
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getVirtualRowTranslateY,
  isConversationNearBottom,
  type VirtualizedListRef,
} from './VirtualizedList';

const ESTIMATED_ROW_HEIGHT = 128;
const OVERSCAN = 10;

interface AgentTimelineConversationProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onAtBottomChange?: (isAtBottom: boolean) => void;
}

/** Nav dots derived from the timeline's user turns (one dot per user message). */
export function buildTimelineNavEntries(
  timeline: ConversationTimelineTurn[]
): ConversationMessageNavEntry[] {
  const entries: ConversationMessageNavEntry[] = [];
  let ordinal = 0;
  timeline.forEach((row, index) => {
    if (row.turn.role !== 'user') return;
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

export function isTimelineTurnInFlight(
  timeline: ConversationTimelineTurn[]
): boolean {
  return timeline.some(
    (row) => row.phase === 'streaming' || row.phase === 'optimistic'
  );
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

function assistantCopyText(turn: MessageTurn): string {
  return turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n');
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
    const total =
      Number(usage.input_tokens) +
      Number(usage.output_tokens) +
      Number(usage.cache_creation_input_tokens) +
      Number(usage.cache_read_input_tokens);
    if (total <= 0) continue;
    return { total_tokens: total, model_context_window: window };
  }
  return null;
}

/** Turn stats for a settled assistant turn, sourced from the parsed MessageTurn. */
function buildSettledTurnStats(turn: MessageTurn): TurnStatsData {
  const usage = turn.usage ?? null;
  return {
    model: turn.model ?? null,
    startedAt: turn.timestamp,
    totalTokens: usage
      ? Number(usage.input_tokens) +
        Number(usage.output_tokens) +
        Number(usage.cache_creation_input_tokens) +
        Number(usage.cache_read_input_tokens)
      : null,
    contextWindow: null,
    cacheReadTokens: usage ? Number(usage.cache_read_input_tokens) : null,
    cacheWriteTokens: usage ? Number(usage.cache_creation_input_tokens) : null,
    elapsedMs: turn.duration_ms != null ? Number(turn.duration_ms) : null,
    completedAt: turn.completed_at ?? null,
    stopReason: null,
  };
}

function ConversationSideRows({
  rows,
  showSessionNotices,
  onRespondQuestion,
  respondingQuestionId,
  onOpenChild,
}: {
  rows: TimelineRow[];
  showSessionNotices: boolean;
  onRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void;
  respondingQuestionId: string | null;
  onOpenChild?: (childConversationId: string) => void;
}) {
  const { t } = useTranslation(['conversation']);
  // turn_error renders as the standalone TurnErrorCard; file_change_summary is
  // anchored inline at the end of its own turn (TurnFileChangesCard); pending
  // permission requests dock at the bottom of the stream instead.
  const visibleRows = rows.filter(
    (entry) =>
      entry.row.kind !== 'turn_error' &&
      entry.row.kind !== 'file_change_summary' &&
      entry.row.kind !== 'permission_request' &&
      (showSessionNotices || entry.row.kind !== 'session_notice')
  );
  if (visibleRows.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      {visibleRows.map((entry, index) => {
        const row = entry.row;
        if (row.kind === 'question_request') {
          return (
            <QuestionRequestCard
              key={`question-${row.request.question_id}-${index}`}
              request={row.request}
              response={row.response ?? null}
              onRespond={onRespondQuestion}
              responding={respondingQuestionId === row.request.question_id}
            />
          );
        }
        if (row.kind === 'feedback_request') {
          return (
            <div
              key={`feedback-${row.request.feedback_id}-${index}`}
              className="rounded-md border border-violet-300/50 bg-violet-50 px-3 py-2 text-xs text-violet-950 dark:border-violet-500/30 dark:bg-violet-950/25 dark:text-violet-100"
            >
              <div className="font-medium">Feedback requested</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-violet-800/80 dark:text-violet-100/75">
                {row.request.prompt}
              </div>
            </div>
          );
        }
        if (row.kind === 'terminal_summary') {
          return (
            <div
              key={`terminal-${row.terminal.terminal_id}-${index}`}
              className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
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
        if (row.kind === 'delegation') {
          return (
            <DelegationCard
              key={`delegation-${row.delegation.delegation_id}-${index}`}
              delegation={row.delegation}
              onOpenChild={onOpenChild}
            />
          );
        }
        if (row.kind === 'session_notice') {
          const copy = getConversationSessionNoticeCopy(row.notice, t);
          return (
            <div
              key={`notice-${index}`}
              className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            >
              <div className="font-medium text-foreground">{copy.title}</div>
              {copy.message ? (
                <div className="mt-1 whitespace-pre-wrap break-words">
                  {copy.message}
                </div>
              ) : null}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
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
>(function AgentTimelineConversation({ attempt, task, onAtBottomChange }, ref) {
  const { t } = useTranslation(['panels', 'conversation', 'common']);
  const queryClient = useQueryClient();
  const { config } = useUserSystem();
  const collapseProcess = config?.ai_message_default_collapsed ?? false;
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const scrollBehavior: ScrollBehavior = prefersReducedMotion
    ? 'auto'
    : 'smooth';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const isAtBottomRef = useRef(true);

  const sessionId = attempt.session?.id ?? null;
  // Absolute workspace root for resolving clickable file paths in messages.
  // Non-worktree workspaces leave container_ref null, so fall back to the repo
  // path — otherwise a relative "README.md" can't be opened in a preview tab.
  const { repos } = useAttemptRepo(attempt.id);
  const workspaceRoot = attempt.container_ref ?? repos[0]?.path ?? null;
  const conversation = useConversationTimeline(sessionId);
  const conversationStatus = useOptionalConversationStatus();
  const setConversationStatusNotices = conversationStatus?.setNotices;
  const usesComposerStatusDock = conversationStatus?.enabled ?? false;
  const timeline = conversation.timeline;
  const isTurnInFlight = useMemo(
    () => isTimelineTurnInFlight(timeline),
    [timeline]
  );
  const detailLoading = conversation.loading;
  const conversationError = conversation.error;
  const sideRows = conversation.sideRows;
  useEffect(() => {
    if (conversationError) toast.error(conversationError);
  }, [conversationError]);
  // Stable reference (memoized in the hook) for the reset-to-here retry flow.
  const conversationResetAndReload = conversation.resetAndReload;
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
  // A delegated sub-agent runs in the parent's workspace (the spawner inherits
  // parent.workspace_id), so the child transcript lives at the same project +
  // workspace route — only the session id changes. Open it only when the route
  // context is known.
  const navigate = useNavigate();
  const routeParams = useParams<{ projectId?: string; workspaceId?: string }>();
  const { projectId, workspaceId } = routeParams;
  const handleOpenChild = useMemo(() => {
    if (!projectId || !workspaceId) return undefined;
    return (childConversationId: string) =>
      navigate(
        paths.projectSession(projectId, workspaceId, childConversationId)
      );
  }, [navigate, projectId, workspaceId]);
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
  const latestSessionNoticeRow = sideRows
    .filter((entry) => entry.row.kind === 'session_notice')
    .at(-1);

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

  const liveStats = useMemo<TurnStatsData>(
    () => ({
      model: null,
      totalTokens: null,
      contextWindow: null,
    }),
    []
  );

  const navEntries = useMemo(
    () => buildTimelineNavEntries(timeline),
    [timeline]
  );
  const userMessageIndexes = useMemo(
    () =>
      timeline.flatMap((row, index) =>
        row.turn.role === 'user' ? [index] : []
      ),
    [timeline]
  );
  const activeNavEntry = useMemo(
    () => findActiveConversationMessageNavEntry(navEntries, activeIndex),
    [activeIndex, navEntries]
  );

  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: timeline.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => timeline[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const updateAtBottomState = useCallback(() => {
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
    const next = findViewportAnchorVirtualIndex(
      rowVirtualizer.getVirtualItems(),
      container.scrollTop,
      container.clientHeight
    );
    setActiveIndex((current) => (current === next ? current : next));
  }, [rowVirtualizer]);

  const handleScroll = useCallback(() => {
    updateAtBottomState();
    updateActiveIndex();
  }, [updateActiveIndex, updateAtBottomState]);

  const detachFromBottom = useCallback(() => {
    if (!isAtBottomRef.current) return;
    isAtBottomRef.current = false;
    onAtBottomChange?.(false);
  }, [onAtBottomChange]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      if (timeline.length > 0) {
        rowVirtualizer.scrollToIndex(timeline.length - 1, {
          align: 'end',
          behavior,
        });
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior });
      }
      isAtBottomRef.current = true;
      onAtBottomChange?.(true);
    },
    [onAtBottomChange, rowVirtualizer, timeline.length]
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      if (index < 0 || index >= timeline.length) return;
      detachFromBottom();
      // Nav-dot jumps pin the target user message to the top of the panel.
      rowVirtualizer.scrollToIndex(index, {
        align: 'start',
        behavior: scrollBehavior,
      });
      setActiveIndex(index);
    },
    [detachFromBottom, rowVirtualizer, scrollBehavior, timeline.length]
  );

  const updateScrollMargin = useCallback(() => {
    const container = containerRef.current;
    const list = virtualListRef.current;
    if (!container || !list) return;
    const next = Math.max(
      0,
      list.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop
    );
    setScrollMargin((current) =>
      Math.abs(current - next) > 1 ? next : current
    );
  }, []);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [sideRows.length, timeline.length, updateScrollMargin]);

  useLayoutEffect(() => {
    updateActiveIndex();
  }, [updateActiveIndex, virtualRows]);

  // Stick to the bottom as the conversation grows, unless the user scrolled up.
  useLayoutEffect(() => {
    if (timeline.length === 0) {
      updateAtBottomState();
      return;
    }
    if (isAtBottomRef.current) {
      scrollToBottom('auto');
    }
  }, [scrollToBottom, timeline.length, totalSize, updateAtBottomState]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom() {
        scrollToBottom(scrollBehavior);
      },
      scrollToIndex(index, options) {
        if (index < 0 || index >= timeline.length) return;
        if ((options?.behavior ?? scrollBehavior) === 'smooth') {
          detachFromBottom();
        }
        rowVirtualizer.scrollToIndex(index, {
          align: options?.align ?? 'center',
          behavior: options?.behavior ?? scrollBehavior,
        });
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
        rowVirtualizer.scrollToIndex(target, {
          align: 'center',
          behavior: scrollBehavior,
        });
      },
    }),
    [
      detachFromBottom,
      rowVirtualizer,
      scrollBehavior,
      scrollToBottom,
      timeline.length,
      userMessageIndexes,
    ]
  );

  useEffect(() => {
    isAtBottomRef.current = true;
    onAtBottomChange?.(true);
  }, [onAtBottomChange, sessionId]);

  // Inline turn stats are sourced from the parsed MessageTurn / live usage.
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
              rowVirtualizer.scrollToIndex(jumpTarget, {
                align: 'center',
                behavior: scrollBehavior,
              });
            };
      const copyText = assistantCopyText(row.turn);
      return row.phase === 'streaming' ? (
        <LiveTurnStats
          stats={liveStats}
          startedAt={row.turn.timestamp}
          copyText={copyText}
          onJumpBack={onJumpBack}
        />
      ) : (
        <TurnStats
          stats={buildSettledTurnStats(row.turn)}
          copyText={copyText}
          onJumpBack={onJumpBack}
        />
      );
    },
    [
      detachFromBottom,
      liveStats,
      rowVirtualizer,
      scrollBehavior,
      userMessageIndexes,
    ]
  );

  // The Nth user turn maps to the Nth checkpoint ordinal (see G-R1).
  const userOrdinalByKey = useMemo(() => {
    const map = new Map<string, number>();
    let ordinal = 0;
    for (const row of timeline) {
      if (row.turn.role === 'user') {
        map.set(row.key, ordinal);
        ordinal += 1;
      }
    }
    return map;
  }, [timeline]);
  const lastUserRowKey = navEntries.at(-1)?.key ?? null;
  const latestInterruptedRow = useMemo(() => {
    const latestRow = timeline.at(-1);
    return latestRow?.turn.role === 'user' && latestRow.phase === 'interrupted'
      ? latestRow
      : null;
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
        const preview = await conversationApi.previewCheckpointFileChanges({
          conversationId: session.id,
          ordinal,
        });
        rollbackFiles = preview.files;
      } catch (error) {
        previewUnavailable = true;
        console.warn('checkpoint preview unavailable', error);
      }

      const choice = await ResendCheckpointDialog.show({
        title: t('timeline.resendMessageTitle'),
        files: rollbackFiles,
        previewUnavailable,
      });
      if (choice === 'dismissed') return false;
      const restoreFiles = choice === 'restore';

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

  const composerStatusNotices = useMemo(() => {
    if (!usesComposerStatusDock) return [];

    const notices = [];
    if (latestTurnError && latestTurnErrorRow) {
      notices.push({
        id: latestTurnErrorRow.row_id,
        kind: 'turn-error' as const,
        error: latestTurnError,
        onReload: conversationResetAndReload,
      });
    }
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
      latestSessionNoticeRow?.row.kind === 'session_notice' &&
      latestSessionNoticeRow.row.notice
    ) {
      notices.push({
        id: latestSessionNoticeRow.row_id,
        kind: 'session-notice' as const,
        notice: latestSessionNoticeRow.row.notice,
      });
    }
    return notices;
  }, [
    conversationResetAndReload,
    handleRetry,
    latestInterruptedRow,
    latestSessionNoticeRow,
    latestTurnError,
    latestTurnErrorRow,
    userOrdinalByKey,
    usesComposerStatusDock,
  ]);

  useEffect(() => {
    setConversationStatusNotices?.(composerStatusNotices);
  }, [composerStatusNotices, setConversationStatusNotices]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto px-2 py-3"
      data-panel="conversation-logs"
      onScroll={handleScroll}
    >
      {detailLoading && timeline.length === 0 ? (
        <div className="flex h-full min-h-[160px] items-center justify-center text-muted-foreground">
          <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading session...</span>
          </div>
        </div>
      ) : (
        <div className="conv-thread-shell relative mx-auto w-full max-w-6xl">
          <div className="conv-thread-content min-w-0">
            {latestTurnError && !usesComposerStatusDock ? (
              <TurnErrorCard
                error={latestTurnError}
                onReload={conversationResetAndReload}
              />
            ) : null}
            <ConversationSideRows
              rows={sideRows}
              showSessionNotices={!usesComposerStatusDock}
              onRespondQuestion={handleRespondQuestion}
              respondingQuestionId={respondingQuestionId}
              onOpenChild={handleOpenChild}
            />
            <div
              ref={virtualListRef}
              className="relative w-full"
              style={{ height: `${totalSize}px` }}
            >
              {virtualRows.map((virtualRow) => {
                const row = timeline[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className={cn(
                      'absolute left-0 top-0 w-full pb-3',
                      activeNavEntry?.index === virtualRow.index &&
                        'conv-message-nav-target-active'
                    )}
                    style={{
                      transform: getVirtualRowTranslateY(
                        virtualRow.start,
                        scrollMargin
                      ),
                    }}
                  >
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
                      showInterruptedNotice={!usesComposerStatusDock}
                    />
                    {row.turn.role === 'assistant'
                      ? (() => {
                          const turnId = row.turn.id.replace(/:assistant$/, '');
                          const fileChanges = fileChangesByTurnId.get(turnId);
                          if (!fileChanges) return null;
                          return (
                            <TurnFileChangesCard
                              summary={fileChanges.summary}
                              expansionKey={`turn-files:${turnId}`}
                              defaultExpanded={
                                !(
                                  config?.files_changed_default_collapsed ??
                                  false
                                )
                              }
                              onUndo={() => void handleUndoTurnChanges(turnId)}
                              undoDisabled={isTurnInFlight}
                            />
                          );
                        })()
                      : null}
                    {renderTurnStats(row, virtualRow.index)}
                  </div>
                );
              })}
            </div>
            {pendingPermissions.length > 0 ? (
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
          <div className="conv-message-nav-anchor">
            <ConversationMessageNav
              entries={navEntries}
              activeIndex={activeIndex}
              onSelect={scrollToIndex}
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default AgentTimelineConversation;
