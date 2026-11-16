import {
  conversationRuntimeStatus,
  requestStatusKey,
} from '@/features/conversation/runtimeStatus';
import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ConversationTimelineSkeleton } from '@/components/logs/ConversationTimelineSkeleton';
import { ConversationFindBar } from '@/components/NormalizedConversation/conversation/ConversationFindBar';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppContextMenu } from '@/components/context-menu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { ConversationSelectionToolbar } from '@/components/NormalizedConversation/ConversationSelectionToolbar';
import { copyConversationMarkdown } from '@/lib/copyConversationMarkdown';
import { exportConversation } from '@/lib/exportConversation';
import { requestCreateSessionInExecutionArea } from '@/lib/requestCreateSession';
import { requestConversationScrollToGoal } from '@/lib/conversationScroll';
import { writeClipboardViaBridge } from '@/vscode/bridge';

import type {
  AgentElicitationResponse,
  AgentKind,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  ConversationFileChange,
  MessageTurn,
  TaskWithAttemptStatus,
  TimelineRow,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { SessionAsyncTaskBar } from '@/components/NormalizedConversation/conversation/SessionAsyncTaskBar';
import { SessionGoalBar } from '@/components/NormalizedConversation/conversation/SessionGoalBar';
import {
  collectAskQuestionToolUses,
  findMatchingAskQuestionToolInUses,
} from '@/components/NormalizedConversation/TurnActivity';
import { isOrphanedQuestionResponseError } from '@/components/tasks/follow-up/AgentQuestionCard';
import { ChildConversationViewer } from '@/components/NormalizedConversation/conversation/ChildConversationViewer';
import {
  appendChildConversationStack,
  popChildConversationStack,
} from '@/components/NormalizedConversation/conversation/childConversationStack';

import { SubagentLifecycleProvider } from '@/components/NormalizedConversation/tools/SubagentLifecycleContext';
import { ConversationStatusDock } from '@/components/tasks/follow-up/ConversationStatusDock';
import { PluginTimelineCards } from '@/components/plugins/PluginTimelineCards';
import { agentsApi } from '@/features/agents/api';
import { conversationApi } from '@/features/conversation/conversationApi';
import { ConversationChildrenSummary } from '@/features/conversation/ConversationChildrenSummary';
import { PiProjectTrustBanner } from '@/features/conversation/PiProjectTrustBanner';
import { nextSurfaceActive } from '@/features/conversation/surfaceActivity';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';
import { ConfirmDialog } from '@/components/dialogs';
import {
  ResendCheckpointDialog,
  shouldConfirmResendCheckpoint,
  type RollbackSafetyReport,
} from '@/components/dialogs';
import { loadResendCheckpointPreview } from '@/components/logs/resendCheckpointPreview';
import { getErrorMessage } from '@/lib/modals';
import { toast } from '@/components/ui/toast';
import { SideChatPane } from './sidechat/SideChatPane';
import { useUserSystem } from '@/components/ConfigProvider';
import { ConversationMessageNav } from './thread/ConversationMessageNav';
import {
  isAgentHandoffHostNote,
  normalizeAgentIdentity,
  shouldShowDurableHostNote,
  type ConversationSessionModesState,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';

const EMPTY_TIMELINE_FOR_ROW: ConversationTimelineTurn[] = [];
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { WorkflowRunCard } from '@/features/workflow/WorkflowRunCard';
import { useOptionalConversationStatus } from '@/contexts/ConversationStatusContext';
import { useSessionSurfaceChrome } from '@/contexts/SessionSurfaceChromeContext';
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
import { virtualRowFoldEdge } from '@/components/logs/assistantVirtualSlices';
import { TimelineImagePanel } from '@/components/NormalizedConversation/TimelineDecodedImage';
import { ConversationTailHandoff } from '@/components/NormalizedConversation/ContextHandoffDivider';
import { RateLimitRecoveryBanner } from '@/components/NormalizedConversation/RateLimitRecoveryBanner';
import { cn } from '@/lib/utils';
import { useLayoutStore } from '@/stores/useLayoutStore';
import {
  findPreviousUserMessageVirtualIndex,
  isConversationExpansionToggle,
  wheelDetachesConversationFollow,
  type VirtualizedListRef,
} from '@/components/logs/VirtualizedList';
import { computeAnchoredTimelineStartIndex } from '@/features/conversation/timelinePaging';
import {
  LOAD_OLDER_THRESHOLD_PX,
  buildContextCompactPresentationByRowKey,
  buildLiveTurnStats,
  buildResendTurnPayload,
  buildSettledTurnStats,
  buildTimelineNavEntries,
  contextCompactPresentationForRow,
  conversationThreadMaxWidthClass,
  dimoTurnIdFromTimelineRowId,
  getLatestTimelinePlanEntries,
  isEditableUserTimelineRow,
  isTimelineTurnInFlight,
  mergeMissingTurnStats,
  parseSideRowTurnAliases,
  shouldLoadOlderTimelinePage,
  timelineItemAsMessage,
  timelineToPatchEntries,
  turnCopyText,
} from './timelineMemoHelpers';
import {
  InlineStreamRuntimeRow,
  TimelineVirtualRowItem,
} from './TimelineVirtualRowItem';
import { useTimelineContextSync } from './useTimelineContextSync';
import { useTimelineScrollController } from './useTimelineScrollController';

const EMPTY_TIMELINE_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};
const EMPTY_TIMELINE_CONFIG_OPTIONS: AgentSessionConfigOption[] = [];

export {
  computeAnchoredTimelineStartIndex,
  conversationThreadMaxWidthClass,
  LOAD_OLDER_THRESHOLD_PX,
  shouldLoadOlderTimelinePage,
  buildTimelineNavEntries,
  dimoTurnIdFromTimelineRowId,
  isTimelineTurnInFlight,
  getLatestTimelinePlanEntries,
  isEditableUserTimelineRow,
  contextCompactPresentationForRow,
  buildContextCompactPresentationByRowKey,
  buildLiveTurnStats,
  buildSettledTurnStats,
  mergeMissingTurnStats,
  timelineToPatchEntries,
  buildResendTurnPayload,
};

interface AgentTimelineConversationProps {
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  onAtBottomChange?: (isAtBottom: boolean) => void;
  widthMode?: 'bounded' | 'workspace';
}

/**
 * Conversation view backed by the canonical Dimo event log: projected timeline
 * rows are hydrated from storage and updated from `conversation-events`, then
 * rendered turn-by-turn via {@link MessageTurnView}.
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { config } = useUserSystem();
  const { collapseAiMessages: collapseProcess, expandFileChanges } =
    resolveConversationCollapsePreferences(config);
  const hideThinking = resolveHideModelThinking(config);
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const scrollBehavior: ScrollBehavior = prefersReducedMotion
    ? 'auto'
    : 'smooth';
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [surfaceActive, setSurfaceActive] = useState(true);

  const sessionId = attempt.session?.id ?? null;
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
  const usesComposerStatusDock = useOptionalConversationStatus()?.enabled ?? false;
  const { hidePersonaHostNotes } = useSessionSurfaceChrome();
  const timeline = conversation.timeline;
  const isTurnInFlight = useMemo(
    () => isTimelineTurnInFlight(timeline),
    [timeline]
  );
  const detailLoading = conversation.loading;
  const conversationError = conversation.error;
  const sideRows = conversation.sideRows;
  const runtimeStatus = conversationRuntimeStatus(sideRows);
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
  const askQuestionUses = useMemo(
    () => collectAskQuestionToolUses(timeline),
    [timeline]
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
        if (kind === 'session_notice') {
          return shouldShowDurableHostNote(item.row, {
            hidePersonaHostNotes,
          });
        }
        if (item.row.row.kind === 'question_request') {
          if (!item.row.row.response && usesComposerStatusDock) {
            return false;
          }
          if (
            item.row.row.response &&
            findMatchingAskQuestionToolInUses(
              item.row.row.request,
              askQuestionUses
            ) !== null
          ) {
            return false;
          }
        }
        return true;
      }),
    [
      askQuestionUses,
      conversation.items,
      hidePersonaHostNotes,
      usesComposerStatusDock,
    ]
  );

  const navEntries = useMemo(
    () => buildTimelineNavEntries(timelineItems),
    [timelineItems]
  );
  const contextCompactByRowKey = useMemo(
    () => buildContextCompactPresentationByRowKey(timeline),
    [timeline]
  );

  const {
    containerRef,
    virtualListRef,
    scrollMargin,
    rowVirtualizer,
    virtualEntries,
    virtualRows,
    totalSize,
    visibleTimelineStartIndex,
    visibleTimelineItems,
    hasEarlierTimeline,
    loadEarlierTimeline,
    activeIndex,
    activeNavEntry,
    userMessageIndexes,
    findOpen,
    setFindOpen,
    findQuery,
    setFindQuery,
    findMatchIndex,
    setFindMatchIndex,
    findMatches,
    currentFindMatch,
    goToFindMatch,
    detachFromBottom,
    handleJumpToVirtualIndex,
    handleScroll,
    scrollToIndex,
    scrollTailOverlayIntoView,
    markExpansionInView,
  } = useTimelineScrollController({
    ref,
    panelRef,
    sessionId,
    timeline,
    timelineItems,
    navEntries,
    sideRowsLength: sideRows.length,
    hasEarlier: conversation.hasEarlier,
    loadOlder: conversation.loadOlder,
    olderTurnsPrependEpoch: conversation.olderTurnsPrependEpoch,
    collapseProcess,
    hideThinking,
    contextCompactByRowKey,
    scrollBehavior,
    onAtBottomChange,
  });

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
  }, [containerRef]);

  useEffect(() => {
    if (conversationError) toast.error(conversationError);
  }, [conversationError]);

  const conversationResetAndReload = conversation.resetAndReload;
  const conversationReconnectAndReload = conversation.reconnectAndReload;
  const conversationCancel = conversation.cancel;
  const conversationRebindSession = useCallback(async () => {
    if (!sessionId) return;
    await conversationApi.rebindSession(sessionId);
    await conversationResetAndReload();
  }, [conversationResetAndReload, sessionId]);

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

  const conversationRespondQuestion = conversation.respondQuestion;
  const [respondingQuestionId, setRespondingQuestionId] = useState<
    string | null
  >(null);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(
    () => new Set()
  );
  useEffect(() => {
    setDismissedQuestionIds(new Set());
  }, [sessionId]);
  const handleDismissQuestion = useCallback((questionId: string) => {
    setDismissedQuestionIds((prev) => {
      if (prev.has(questionId)) return prev;
      const next = new Set(prev);
      next.add(questionId);
      return next;
    });
  }, []);
  const handleRespondQuestion = useCallback(
    async (questionId: string, response: AgentElicitationResponse) => {
      setRespondingQuestionId(questionId);
      try {
        await conversationRespondQuestion(questionId, response);
      } catch (error: unknown) {
        toast.error(getErrorMessage(error));
        if (
          response.action === 'decline' &&
          isOrphanedQuestionResponseError(error)
        ) {
          handleDismissQuestion(questionId);
        }
        throw error;
      } finally {
        setRespondingQuestionId((current) =>
          current === questionId ? null : current
        );
      }
    },
    [conversationRespondQuestion, handleDismissQuestion]
  );

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
    setChildStack([]);
  }, [sessionId]);

  const { getActiveExecutorProfile } = useActiveExecutorProfile();
  const latestTurnErrorRow = useMemo(
    () =>
      sideRows
        .filter(
          (entry) =>
            entry.row.kind === 'turn_error' &&
            (!runtimeStatus.request ||
              !entry.row.error.turn_id ||
              entry.row.error.turn_id === runtimeStatus.request.turn_id)
        )
        .at(-1),
    [runtimeStatus.request, sideRows]
  );
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
      const aliases = parseSideRowTurnAliases(entry.row_id);
      if (aliases.userTurnId) ids.add(aliases.userTurnId);
      if (aliases.assistantTurnId) ids.add(aliases.assistantTurnId);
    }
    return ids;
  }, [sideRows]);
  const latestInterruptedRow = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const row = timeline[i]!;
      if (row.turn.role === 'user' && !row.turn.id.includes(':steer:')) {
        return row.phase === 'interrupted' ? row : null;
      }
    }
    return null;
  }, [timeline]);

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
  // The Nth user turn maps to the Nth checkpoint ordinal (see G-R1).
  const userOrdinalByKey = useMemo(() => {
    const map = new Map<string, number>();
    let ordinal = conversation.userTurnsBeforeOffset;
    for (const item of timelineItems) {
      const row = timelineItemAsMessage(item);
      if (row?.turn.role === 'user' && !row.turn.id.includes(':steer:')) {
        map.set(row.key, ordinal);
        ordinal += 1;
      }
    }
    return map;
  }, [conversation.userTurnsBeforeOffset, timelineItems]);
  const lastUserRowKey = navEntries.at(-1)?.key ?? null;

  const userOrdinalByTurnId = useMemo(() => {
    const map = new Map<string, number>();
    let nextOrdinal = conversation.userTurnsBeforeOffset;
    let activeOrdinal: number | null = null;
    for (const row of timeline) {
      if (row.turn.role === 'user' && !row.turn.id.includes(':steer:')) {
        activeOrdinal = nextOrdinal;
        nextOrdinal += 1;
        map.set(row.turn.id.replace(/:user$/, ''), activeOrdinal);
      } else if (row.turn.role === 'assistant' && activeOrdinal !== null) {
        map.set(dimoTurnIdFromTimelineRowId(row.turn.id), activeOrdinal);
      }
    }
    if (
      conversation.currentTurnId &&
      activeOrdinal !== null &&
      !map.has(conversation.currentTurnId)
    ) {
      map.set(conversation.currentTurnId, activeOrdinal);
    }
    for (const entry of sideRows) {
      const aliases = parseSideRowTurnAliases(entry.row_id);
      const turnUuid =
        entry.row.kind === 'file_change_summary'
          ? entry.row.turn_id
          : entry.row.kind === 'turn_error'
            ? entry.row.error.turn_id
            : null;
      const ord =
        (turnUuid ? map.get(turnUuid) : undefined) ??
        (aliases.userTurnId ? map.get(aliases.userTurnId) : undefined) ??
        (aliases.assistantTurnId
          ? map.get(aliases.assistantTurnId)
          : undefined);
      if (ord !== undefined) {
        if (turnUuid) map.set(turnUuid, ord);
        if (aliases.userTurnId) map.set(aliases.userTurnId, ord);
        if (aliases.assistantTurnId) map.set(aliases.assistantTurnId, ord);
      }
    }
    return map;
  }, [
    conversation.currentTurnId,
    conversation.userTurnsBeforeOffset,
    sideRows,
    timeline,
  ]);

  const fileChangesByTurnId = useMemo(() => {
    const map = new Map<
      string,
      Extract<TimelineRow['row'], { kind: 'file_change_summary' }>
    >();
    const lastAssistantTurnId = (() => {
      for (let i = timeline.length - 1; i >= 0; i -= 1) {
        const r = timeline[i];
        if (r?.turn.role === 'assistant') {
          return dimoTurnIdFromTimelineRowId(r.turn.id);
        }
      }
      return null;
    })();
    for (const entry of sideRows) {
      if (entry.row.kind !== 'file_change_summary') continue;
      if (!entry.row.turn_id) continue;
      map.set(entry.row.turn_id, entry.row);
      const aliases = parseSideRowTurnAliases(entry.row_id);
      if (aliases.userTurnId) map.set(aliases.userTurnId, entry.row);
      if (aliases.assistantTurnId) map.set(aliases.assistantTurnId, entry.row);
      if (
        conversation.currentTurnId &&
        entry.row.turn_id === conversation.currentTurnId &&
        lastAssistantTurnId
      ) {
        map.set(lastAssistantTurnId, entry.row);
      }
    }
    return map;
  }, [conversation.currentTurnId, sideRows, timeline]);

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

  const sessionAgentType = (attempt.session?.agent_id ??
    attempt.session?.executor) as AgentKind | null;
  const normalizedSessionAgent = normalizeAgentIdentity(sessionAgentType);
  const controlsMatchSessionAgent =
    !normalizedSessionAgent ||
    !conversation.controlsAgentId ||
    conversation.controlsAgentId === normalizedSessionAgent;
  const conversationSessionModes = controlsMatchSessionAgent
    ? conversation.sessionModes
    : EMPTY_TIMELINE_SESSION_MODES;
  const conversationSessionConfigOptions = controlsMatchSessionAgent
    ? conversation.sessionConfigOptions
    : EMPTY_TIMELINE_CONFIG_OPTIONS;

  const handleRetry = useCallback(
    async (
      turn: MessageTurn,
      ordinal: number,
      replacementText?: string
    ): Promise<boolean> => {
      const session = attempt.session;
      if (!session?.executor) return false;
      const resendPayload = buildResendTurnPayload({
        turn,
        replacementText,
        sessionModes: conversationSessionModes,
        sessionConfigOptions: conversationSessionConfigOptions,
      });
      if (!resendPayload) return false;

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

      let safetyReport: RollbackSafetyReport | undefined;
      if (typeof conversationApi.checkRollbackSafety === 'function') {
        try {
          safetyReport = await conversationApi.checkRollbackSafety({
            conversationId: session.id,
            ordinal,
          });
        } catch (error) {
          console.warn('rollback safety check unavailable', error);
        }
      }

      let restoreFiles = false;
      if (
        shouldConfirmResendCheckpoint({
          files: rollbackFiles,
          previewUnavailable: false,
          safetyReport,
        })
      ) {
        const choice = await ResendCheckpointDialog.show({
          title: t('timeline.resendMessageTitle'),
          files: rollbackFiles,
          previewUnavailable,
          safetyReport,
        });
        if (choice === 'dismissed') return false;
        restoreFiles = choice === 'restore';
      }

      try {
        if (restoreFiles) {
          try {
            await agentsApi.resetToCheckpoint(session.id, ordinal, true, false);
          } catch (error) {
            console.warn('checkpoint restore skipped', error);
          }
        }

        await conversationApi.truncateToTurn({
          conversationId: session.id,
          ordinal,
        });
        await conversationResetAndReload();
        await conversationApi.ensureSessionControls(session.id, {
          reload: false,
        });

        await sendAgentRuntimeTurn({
          workspaceId: attempt.id,
          sessionId: session.id,
          executorProfileId: resolveResendExecutorProfile(
            getActiveExecutorProfile(),
            session.executor as AgentKind
          ),
          ...resendPayload,
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
      conversationSessionConfigOptions,
      conversationSessionModes,
      getActiveExecutorProfile,
      t,
    ]
  );

  const handleCancelRuntimeRequest = useCallback(async () => {
    try {
      await conversationCancel();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [conversationCancel]);

  const latestRetryableUserRow = useMemo(() => {
    if (isTurnInFlight) return null;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const entry = timeline[i]!;
      if (entry.turn.role === 'user' && !entry.turn.id.includes(':steer:')) {
        return entry;
      }
    }
    return null;
  }, [isTurnInFlight, timeline]);

  const handleRetryLatestTurn = useMemo(
    () =>
      latestRetryableUserRow
        ? () =>
            handleRetry(
              latestRetryableUserRow.turn,
              userOrdinalByKey.get(latestRetryableUserRow.key) ?? 0
            )
        : undefined,
    [handleRetry, latestRetryableUserRow, userOrdinalByKey]
  );

  const {
    timelineTurns,
    liveStats,
    pendingQuestionRow,
    pendingPermissions,
    hasPendingPermission,
    streamingAssistantRow,
    hasStreamingAssistantContent,
    hasRunningTool,
    inlineRuntimePresentation,
    statusNotices,
    activeRateLimitState,
    handleRateLimitAutoResume,
    handleRateLimitCancelWait,
  } = useTimelineContextSync({
    attempt,
    sessionId,
    timeline,
    sideRows,
    sessionBindReady: conversation.sessionBindReady,
    connecting: conversation.connecting,
    runtimeConnection: runtimeStatus.connection,
    runtimeRequest: runtimeStatus.request,
    controlsAgentId: conversation.controlsAgentId,
    sessionModes: conversation.sessionModes,
    sessionConfigOptions: conversation.sessionConfigOptions,
    steeringSupported: conversation.steeringSupported,
    currentTurnId: conversation.currentTurnId,
    deliveryChannel: conversation.deliveryChannel,
    isTurnInFlight,
    askQuestionUses,
    latestTurnError,
    latestTurnErrorRow,
    latestInterruptedRow,
    userOrdinalByKey,
    respondingPermissionId,
    respondingQuestionId,
    dismissedQuestionIds,
    handleRespondPermission,
    handleRespondQuestion,
    handleOpenChild,
    handleRetry,
    handleRetryLatestTurn,
    handleCancelRuntimeRequest,
    conversationReconnectAndReload,
    conversationRebindSession,
    searchParams,
    setSearchParams,
  });

  const lastAssistantKey = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const row = timeline[index];
      if (row?.turn.role === 'assistant') return row.key;
    }
    return null;
  }, [timeline]);
  const streamingStatusInfo = useMemo(() => {
    if (
      !streamingAssistantRow ||
      inlineRuntimePresentation.isConnectionRecovering ||
      (!hasStreamingAssistantContent &&
        inlineRuntimePresentation.placement === 'stream' &&
        inlineRuntimePresentation.status != null)
    ) {
      return null;
    }
    const dimoTurnId = dimoTurnIdFromTimelineRowId(
      streamingAssistantRow.turn.id
    );
    const statusLabel =
      (runtimeStatus.connection && !runtimeStatus.connection.bound) ||
      (conversation.connecting && !runtimeStatus.connection?.bound)
        ? t(
            `conversation:runtime.connection.${
              runtimeStatus.connection
                ? runtimeStatus.connection.status === 'ready'
                  ? 'binding'
                  : runtimeStatus.connection.status
                : 'connecting'
            }`
          )
        : t(
            `conversation:runtime.request.${requestStatusKey({
              request: runtimeStatus.request,
              currentTurnId: dimoTurnId,
              connection: runtimeStatus.connection,
              hasInteraction:
                Boolean(pendingQuestionRow) || hasPendingPermission,
              hasRunningTool,
            })}`
          );
    return {
      rowKey: streamingAssistantRow.key,
      status: {
        hideStatus: inlineRuntimePresentation.suppressLiveTurnStatsStatus,
        statusLabel,
        stats: liveStats,
      },
    };
  }, [
    conversation.connecting,
    hasPendingPermission,
    hasRunningTool,
    hasStreamingAssistantContent,
    inlineRuntimePresentation.isConnectionRecovering,
    inlineRuntimePresentation.placement,
    inlineRuntimePresentation.status,
    inlineRuntimePresentation.suppressLiveTurnStatsStatus,
    liveStats,
    pendingQuestionRow,
    runtimeStatus.connection,
    runtimeStatus.request,
    streamingAssistantRow,
    t,
  ]);

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col">
      {findOpen ? (
        <ConversationFindBar
          query={findQuery}
          current={findMatches.length === 0 ? 0 : findMatchIndex + 1}
          total={findMatches.length}
          workspaceId={attempt.id}
          currentConversationId={sessionId}
          onQueryChange={setFindQuery}
          onNext={() => goToFindMatch(1)}
          onPrevious={() => goToFindMatch(-1)}
          onSelectGlobalHit={(hit) => {
            if (!hit.conversation_id || hit.conversation_id === sessionId) {
              return;
            }
            const targetWorkspaceId = hit.workspace_id || attempt.id;
            if (kanbanSessions) {
              kanbanSessions.openSessionFromList({
                sessionId: hit.conversation_id,
                workspaceId: targetWorkspaceId,
              });
            } else if (task?.project_id && targetWorkspaceId) {
              navigate(
                `/local-projects/${task.project_id}/workspaces/${targetWorkspaceId}/sessions/${hit.conversation_id}`
              );
            } else {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('sessionId', hit.conversation_id);
                next.delete('createSession');
                return next;
              });
            }
          }}
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
      <div className="relative flex min-h-0 flex-1 flex-col">
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
              markExpansionInView();
            }
          }}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (isConversationExpansionToggle(event.target)) {
              markExpansionInView();
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
              ? visibleTimelineItems[virtualEntry.timelineIndex]
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
              const turnId = dimoTurnIdFromTimelineRowId(row.turn.id);
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
                    {attempt.session?.executor === 'workflow' && sessionId ? (
                      <WorkflowRunCard runId={sessionId} />
                    ) : null}

                    {hasEarlierTimeline ? (
                      <div className="mb-3 flex justify-center">
                        <button
                          type="button"
                          className="rounded-full border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground"
                          onClick={() => {
                            loadEarlierTimeline();
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
                          const item =
                            visibleTimelineItems[entry.timelineIndex];
                          if (!item) return null;
                          const globalTimelineIndex =
                            entry.timelineIndex + visibleTimelineStartIndex;
                          const row =
                            item.kind === 'message' ? item.item : null;
                          const turnId = row
                            ? dimoTurnIdFromTimelineRowId(row.turn.id)
                            : null;
                          const isCurrentFindMatch =
                            row != null &&
                            currentFindMatch != null &&
                            timeline[currentFindMatch.rowIndex]?.key ===
                              row.key;
                          const foldEdge = virtualRowFoldEdge(
                            virtualEntries,
                            virtualRow.index
                          );
                          const isStreamingStatsRow =
                            Boolean(row) &&
                            entry.isLast &&
                            row?.phase === 'streaming' &&
                            streamingStatusInfo?.rowKey === row.key;
                          const jumpTarget =
                            row?.turn.role === 'assistant' && entry.isLast
                              ? findPreviousUserMessageVirtualIndex(
                                  userMessageIndexes,
                                  virtualRow.index
                                )
                              : null;
                          const fileChanges =
                            row?.turn.role === 'assistant' &&
                            entry.isLast &&
                            turnId
                              ? (fileChangesByTurnId.get(turnId) ?? null)
                              : null;
                          const hasTurnError = row
                            ? turnIdsWithErrors.has(turnId!) ||
                              inlineRuntimePresentation.isConnectionRecovering
                            : false;
                          const suppressStatusRowPadding =
                            entry.slice?.kind === 'status' &&
                            inlineRuntimePresentation.suppressAssistantStreamingStatus;
                          const hideAssistantStats = Boolean(
                            row &&
                              entry.isLast &&
                              row.phase === 'streaming' &&
                              row.turn.blocks.length === 0 &&
                              inlineRuntimePresentation.placement ===
                                'stream' &&
                              inlineRuntimePresentation.status != null
                          );
                          return (
                            <TimelineVirtualRowItem
                              key={virtualRow.key}
                              virtualIndex={virtualRow.index}
                              virtualStart={virtualRow.start}
                              scrollMargin={scrollMargin}
                              measureElement={rowVirtualizer.measureElement}
                              item={item}
                              timeline={
                                item.kind === 'side' &&
                                item.row.row.kind === 'question_request'
                                  ? timeline
                                  : EMPTY_TIMELINE_FOR_ROW
                              }
                              slice={entry.slice}
                              isLastSlice={entry.isLast}
                              foldEdge={foldEdge}
                              isActiveNavTarget={
                                activeNavEntry?.index === globalTimelineIndex
                              }
                              isCurrentFindMatch={isCurrentFindMatch}
                              attempt={attempt}
                              task={task}
                              workspacePath={workspaceRoot}
                              collapseProcess={collapseProcess}
                              expandFileChanges={expandFileChanges}
                              delegations={delegations}
                              questions={timelineQuestions}
                              dismissedQuestionIds={dismissedQuestionIds}
                              onDismissQuestion={handleDismissQuestion}
                              onOpenChild={handleOpenChild}
                              contextCompact={
                                row
                                  ? (contextCompactByRowKey.get(row.key) ??
                                    null)
                                  : null
                              }
                              hasTurnError={hasTurnError}
                              userOrdinal={
                                row?.turn.role === 'user'
                                  ? (userOrdinalByKey.get(row.key) ?? 0)
                                  : 0
                              }
                              isEditableUser={
                                row
                                  ? isEditableUserTimelineRow(
                                      row,
                                      lastUserRowKey
                                    )
                                  : false
                              }
                              onRetryTurn={handleRetry}
                              onRespondQuestion={handleRespondQuestion}
                              isRespondingQuestion={
                                item.kind === 'side' &&
                                item.row.row.kind === 'question_request' &&
                                respondingQuestionId ===
                                  item.row.row.request.question_id
                              }
                              fileChanges={fileChanges}
                              onUndoTurnChanges={handleUndoTurnChanges}
                              isTurnInFlight={isTurnInFlight}
                              forkSupported={forkSupported}
                              jumpTarget={jumpTarget}
                              onJumpToVirtualIndex={handleJumpToVirtualIndex}
                              onForkFromTurn={handleForkFromTurn}
                              liveStatsFallback={
                                row?.key === lastAssistantKey &&
                                !isStreamingStatsRow
                                  ? liveStats
                                  : null
                              }
                              streamingLiveStatus={
                                isStreamingStatsRow
                                  ? (streamingStatusInfo?.status ?? null)
                                  : null
                              }
                              suppressStreamingStatus={
                                inlineRuntimePresentation.suppressAssistantStreamingStatus
                              }
                              suppressStatusRowPadding={
                                suppressStatusRowPadding
                              }
                              hideAssistantStats={hideAssistantStats}
                            />
                          );
                        })}
                      </div>
                    </TimelineImagePanel>
                    {inlineRuntimePresentation.placement === 'stream' &&
                    inlineRuntimePresentation.status ? (
                      <InlineStreamRuntimeRow
                        status={inlineRuntimePresentation.status}
                        onReveal={scrollTailOverlayIntoView}
                        onReconnect={conversationReconnectAndReload}
                        onCancel={handleCancelRuntimeRequest}
                        onRetry={handleRetryLatestTurn}
                      />
                    ) : null}
                    <ConversationTailHandoff
                      sessionId={sessionId}
                      hasMessages={timeline.length > 0}
                      fallbackFromModel={liveStats.model}
                      sessionConfigOptions={conversationSessionConfigOptions}
                      suppressedByInlineHandoff={(() => {
                        const tailItem =
                          timelineItems[timelineItems.length - 1];
                        return Boolean(
                          tailItem?.kind === 'side' &&
                            isAgentHandoffHostNote(tailItem.row)
                        );
                      })()}
                      onReveal={scrollTailOverlayIntoView}
                    />
                    {!usesComposerStatusDock &&
                    pendingPermissions.length > 0 ? (
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
              </>
            )}
          </div>
        </div>
        {!(detailLoading && timeline.length === 0) && navEntries.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 inset-y-3 z-10 px-2">
            <div
              className={cn(
                'relative mx-auto h-full w-full',
                conversationThreadMaxWidthClass(widthMode, isEditorAreaVisible)
              )}
            >
              <div className="conv-message-nav-anchor">
                <ConversationMessageNav
                  entries={navEntries}
                  activeIndex={activeIndex}
                  onSelect={scrollToIndex}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {!usesComposerStatusDock ? (
        <>
          <div className="space-y-2 px-3 pb-1">
            <SessionGoalBar
              sessionGoal={conversation.sessionGoal}
              sessionBindReady={conversation.sessionBindReady}
              onGoalControl={conversation.goalControl}
              onSelectGoal={
                sessionId
                  ? () => requestConversationScrollToGoal(sessionId)
                  : undefined
              }
            />
            <SessionAsyncTaskBar
              tasks={conversation.asyncTasks}
              sessionBindReady={conversation.sessionBindReady}
              onStopTask={conversation.stopAsyncTask}
            />
            {sessionId && activeRateLimitState ? (
              <RateLimitRecoveryBanner
                conversationId={sessionId}
                rateLimit={activeRateLimitState}
                onUpdateAutoResume={handleRateLimitAutoResume}
                onCancelWait={handleRateLimitCancelWait}
              />
            ) : null}
          </div>
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
        </>
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
      {sessionId ? (
        <SideChatPane
          conversationId={sessionId}
          turns={conversation.timeline}
          workspacePath={workspaceRoot}
        />
      ) : null}
    </div>
  );
});

export default AgentTimelineConversation;
