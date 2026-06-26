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
import { useNavigate, useParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BaseCodingAgent } from 'shared/types';
import type {
  AgentPermissionResponse,
  ConversationTimelineRow,
  MessageTurn,
  TaskWithAttemptStatus,
  TokenUsageInfo,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { DelegationCard } from '@/components/NormalizedConversation/conversation/DelegationCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { agentsApi } from '@/features/agents/api';
import { conversationApi } from '@/features/conversation/conversationApi';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import { ConfirmDialog } from '@/components/dialogs';
import { getErrorMessage } from '@/lib/modals';
import { toast } from 'sonner';
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
  onRespondPermission,
  respondingPermissionId,
  onOpenChild,
}: {
  rows: ConversationTimelineRow[];
  onRespondPermission: (
    permissionId: string,
    response: AgentPermissionResponse
  ) => void;
  respondingPermissionId: string | null;
  onOpenChild?: (childConversationId: string) => void;
}) {
  const visibleRows = rows.filter((row) => row.kind !== 'turn_error');
  if (visibleRows.length === 0) return null;

  return (
    <div className="mb-3 space-y-2">
      {visibleRows.map((row, index) => {
        if (row.kind === 'permission_request') {
          return (
            <PermissionRequestCard
              key={`permission-${row.request.permission_id}-${index}`}
              request={row.request}
              onRespond={onRespondPermission}
              responding={
                respondingPermissionId === row.request.permission_id
              }
            />
          );
        }
        if (row.kind === 'question_request') {
          return (
            <div
              key={`question-${row.request.question_id}-${index}`}
              className="rounded-md border border-sky-300/50 bg-sky-50 px-3 py-2 text-xs text-sky-950 dark:border-sky-500/30 dark:bg-sky-950/25 dark:text-sky-100"
            >
              <div className="font-medium">{row.request.prompt}</div>
              {row.request.options.length > 0 ? (
                <div className="mt-1 truncate text-sky-800/80 dark:text-sky-100/75">
                  {row.request.options.join(', ')}
                </div>
              ) : null}
            </div>
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
        if (row.kind === 'file_change_summary') {
          return (
            <div
              key={`files-${index}`}
              className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            >
              <div className="font-medium text-foreground">
                {row.summary.files.length} file change
                {row.summary.files.length === 1 ? '' : 's'}
              </div>
              <div className="mt-1 truncate">
                {row.summary.files.map((file) => file.path).join(', ')}
              </div>
            </div>
          );
        }
        if (row.kind === 'session_notice') {
          return (
            <div
              key={`notice-${index}`}
              className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            >
              <div className="font-medium text-foreground">
                {row.notice.title}
              </div>
              {row.notice.message ? (
                <div className="mt-1 whitespace-pre-wrap break-words">
                  {row.notice.message}
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
  const timeline = conversation.timeline;
  const detailLoading = conversation.loading;
  const sideRows = conversation.sideRows;
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
  const turnErrors = sideRows.flatMap((row) =>
    row.kind === 'turn_error' ? [row.error.error] : []
  );
  const latestTurnError = turnErrors[turnErrors.length - 1] ?? null;

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

  const handleRetry = useCallback(
    async (turn: MessageTurn, ordinal: number) => {
      const session = attempt.session;
      if (!session?.executor) return;
      const text = turn.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n\n');
      if (!text) return;

      // Reset-to-here: re-send this message in its original position and reset
      // everything after it. The two-choice modal only controls the *independent*
      // workspace file rollback (native window.confirm is blocked in the Tauri
      // webview). 'confirmed' = also roll back files; 'canceled' (button/dismiss)
      // = reset context only, leave files as-is.
      const choice = await ConfirmDialog.show({
        title: '重发这条消息',
        message:
          '将把这条消息之后的所有内容清除并在原位重新发送。\n\n是否同时把工作区文件回滚到这条消息发送前?\n\n恢复并重发 = 先回滚文件再发送\n仅重发 = 不改动文件直接发送',
        confirmText: '恢复并重发',
        cancelText: '仅重发',
        variant: 'default',
      });
      const restoreFiles = choice === 'confirmed';

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
            session.executor as BaseCodingAgent
          ),
          text,
        });
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [
      attempt.id,
      attempt.session,
      conversationResetAndReload,
      getActiveExecutorProfile,
    ]
  );

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
            {latestTurnError ? (
              <TurnErrorCard
                error={latestTurnError}
                onReload={conversationResetAndReload}
              />
            ) : null}
            <ConversationSideRows
              rows={sideRows}
              onRespondPermission={handleRespondPermission}
              respondingPermissionId={respondingPermissionId}
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
                      collapseProcess={collapseProcess}
                    />
                    {renderTurnStats(row, virtualRow.index)}
                  </div>
                );
              })}
            </div>
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
