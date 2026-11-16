import { getInvokeErrorMessage, isCanceledError } from '@/lib/errors';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  AsyncTaskRecord,
  ConversationRowOp,
  ConversationSessionGoal,
  DeliveryChannel,
  GoalControlReceipt,
  MessageTurn,
  SessionStats,
  SessionStatus,
} from 'shared/types';
import { listenToAgentEvents } from '@/features/agents/events';
import { conversationApi } from './conversationApi';
import { AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID } from './sessionNoticeNeedsRebind';
import { canSkipInFlightHistoryWait } from './canSkipInFlightHistoryWait';
import { nextOlderTimelinePage } from './timelinePaging';
import { retainConversationKeepalive } from './conversationKeepalive';
import { listenToConversationEvents } from './events';
import {
  acknowledgeOptimisticConversationTurn,
  clearBufferedOptimisticConversationTurnsForTests,
  consumeBufferedOptimisticConversationTurns,
  subscribeToOptimisticConversationTurns,
} from './optimisticTurnEvents';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  normalizeAgentIdentity,
  sideRowsForEntry,
  timelineItemsForEntry,
  timelineTurnsForEntry,
  type ConversationSessionModesState,
  type ConversationStoreState,
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
  type ResettableConversationRowOpBatch,
} from './conversationStore';
import {
  STREAM_FLUSH_BLOCK_CHARS,
  STREAM_FLUSH_CHARS_PER_FRAME,
  STREAM_FLUSH_FRAME_MS,
  STREAM_FLUSH_MAX_MS,
  coalescePendingRowOpBatches,
  hasTerminalTurnOp,
  isPureAppendBatch,
  isResetBatch,
  liveConversationChars,
  normalizeGapPage,
  parkEntryWindowRows,
  streamFlushDelayMs,
  toBigIntSeq,
} from './timelineRegistryHelpers';
import type { TimelineRow } from 'shared/types';

export {
  STREAM_FLUSH_BLOCK_CHARS,
  STREAM_FLUSH_CHARS_PER_FRAME,
  STREAM_FLUSH_FRAME_MS,
  STREAM_FLUSH_MAX_MS,
  isPureAppendBatch,
  liveConversationChars,
  streamFlushDelayMs,
};

const EMPTY_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};
const EMPTY_CONFIG_OPTIONS: AgentSessionConfigOption[] = [];
const EMPTY_ASYNC_TASKS: AsyncTaskRecord[] = [];

const STREAM_QUEUE_CAP = 256;
const SMALL_SEQUENCE_GAP_MAX = 256n;
const MAX_STALE_BIND_RETRIES = 2;
const STALE_BIND_RETRY_DELAY_MS = 150;

type Controller = {
  stopped: boolean;
  loadEpoch: number;
  preDetailBatches: ResettableConversationRowOpBatch[];
  pendingBatches: ResettableConversationRowOpBatch[];
  maxLiveSequenceSeen: bigint;
  flushFrame: number | null;
  flushTimer: number | null;
  bindTimer: number | null;
  cancelBindIdle: (() => void) | null;
  loadingOlder: boolean;
  loadOlderPromise: Promise<void> | null;
  liveStarted: boolean;
  gapFetchedFor: bigint | null;
  unlistenEvents?: () => void;
  unlistenAgent?: () => void;
  unlistenOptimistic?: () => void;
  unsubscribeStore?: () => void;
};

type Slot = {
  refs: number;
  surfaceRefs: number;
  bindReady: boolean;
  connecting: boolean;
  staleBindRetries: number;
  connectionStatus?: string;
  connectionSequence?: number;
  connectionId?: string;
  retiredConnectionIds?: Set<string>;
  bindGeneration?: number;
  keepalive?: () => void;
  controller: Controller | null;
};

export type ConversationTimelineView = {
  timeline: ConversationTimelineTurn[];
  items: ConversationTimelineItem[];
  sideRows: TimelineRow[];
  agentId: string | null;
  controlsAgentId: string | null;
  currentTurnId: string | null;
  steeringSupported: boolean;
  deliveryChannel: DeliveryChannel;
  forkSessionSupported: boolean;
  loading: boolean;
  error: string | null;
  lastSequence: bigint;
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
  sessionGoal: ConversationSessionGoal | null;
  asyncTasks: AsyncTaskRecord[];
  promptSuggestion: string | null;
  goalControl: (action: 'pause' | 'clear') => Promise<GoalControlReceipt>;
  stopAsyncTask: (taskId: string) => Promise<boolean>;
  clearPromptSuggestion: () => void;
  sendOptimisticTurn: (turn: MessageTurn) => void;
  removeOptimisticTurn: (turnId: string) => void;
  refresh: () => void;
  resetAndReload: () => Promise<void>;
  reconnectAndReload: () => Promise<void>;
  cancel: (reason?: string) => Promise<void>;
  respondPermission: (
    permissionId: string,
    response: AgentPermissionResponse
  ) => Promise<void>;
  respondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => Promise<void>;
  hasEarlier: boolean;
  loadOlder: () => Promise<void>;
  olderTurnsPrependEpoch: number;
  userTurnsBeforeOffset: number;
  sessionBindReady: boolean;
  connecting: boolean;
};

const listeners = new Set<() => void>();
const listenersByConversation = new Map<string, Set<() => void>>();
const slots = new Map<string, Slot>();
const inflightBinds = new Map<string, Promise<unknown>>();
const viewCache = new Map<
  string,
  {
    entry: ConversationStoreState['byConversationId'][string] | undefined;
    bindReady: boolean;
    connecting: boolean;
    connectionStatus?: string;
    view: ConversationTimelineView;
  }
>();

export type ConversationSessionFacts = {
  sessionId: string | null;
  hasDetail: boolean;
  error: string | null;
  title: string | null;
  status: SessionStatus | null;
  agentId: string | null;
  model: string | null;
  acpSessionId: string | null;
  externalSessionId: string | null;
  turnInFlight: boolean;
  sessionStats: SessionStats | null;
  truncated: boolean;
  loading: boolean;
};

const EMPTY_SESSION_FACTS: ConversationSessionFacts = {
  sessionId: null,
  hasDetail: false,
  error: null,
  title: null,
  status: null,
  agentId: null,
  model: null,
  acpSessionId: null,
  externalSessionId: null,
  turnInFlight: false,
  sessionStats: null,
  truncated: false,
  loading: false,
};

const factsCache = new Map<
  string,
  {
    entry: ConversationStoreState['byConversationId'][string] | undefined;
    facts: ConversationSessionFacts;
  }
>();

let state: ConversationStoreState = emptyConversationStoreState;

const EMPTY_VIEW: ConversationTimelineView = {
  timeline: [],
  items: [],
  sideRows: [],
  agentId: null,
  controlsAgentId: null,
  currentTurnId: null,
  steeringSupported: false,
  deliveryChannel: 'none',
  forkSessionSupported: false,
  loading: false,
  error: null,
  lastSequence: 0n,
  sessionModes: EMPTY_SESSION_MODES,
  sessionConfigOptions: EMPTY_CONFIG_OPTIONS,
  sessionGoal: null,
  asyncTasks: EMPTY_ASYNC_TASKS,
  promptSuggestion: null,
  goalControl: () =>
    Promise.resolve({
      action: 'clear',
      method: '_session/goal',
      should_interrupt_turn: false,
    }),
  stopAsyncTask: () => Promise.resolve(false),
  clearPromptSuggestion: () => undefined,
  sendOptimisticTurn: () => undefined,
  removeOptimisticTurn: () => undefined,
  refresh: () => undefined,
  resetAndReload: () => Promise.resolve(),
  reconnectAndReload: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
  respondPermission: () => Promise.resolve(),
  respondQuestion: () => Promise.resolve(),
  hasEarlier: false,
  loadOlder: () => Promise.resolve(),
  olderTurnsPrependEpoch: 0,
  userTurnsBeforeOffset: 0,
  sessionBindReady: false,
  connecting: false,
};

function notify(conversationId?: string): void {
  if (conversationId) {
    const scoped = listenersByConversation.get(conversationId);
    if (scoped) {
      for (const listener of scoped) listener();
    }
  } else {
    for (const scoped of listenersByConversation.values()) {
      for (const listener of scoped) listener();
    }
  }
  for (const listener of listeners) listener();
}

function actionConversationId(
  action: Parameters<typeof conversationStoreReducer>[1]
): string | undefined {
  return action.type === 'row_ops'
    ? action.batch.conversation_id
    : action.conversationId;
}

function dispatch(
  action: Parameters<typeof conversationStoreReducer>[1]
): void {
  state = conversationStoreReducer(state, action);
  notify(actionConversationId(action));
}

export function subscribeConversationTimeline(
  listener: () => void,
  conversationId?: string | null
): () => void {
  if (conversationId) {
    let bucket = listenersByConversation.get(conversationId);
    if (!bucket) {
      bucket = new Set();
      listenersByConversation.set(conversationId, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = listenersByConversation.get(conversationId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        listenersByConversation.delete(conversationId);
      }
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type StoredConversationPersona = {
  name: string;
  team_name?: string | null;
  summary?: string | null;
  agent_name: string;
};

export function getConversationPersona(
  conversationId: string | null
): StoredConversationPersona | null {
  if (!conversationId) return null;
  const detail = state.byConversationId[conversationId]?.detail;
  if (!detail) return null;
  const persona = (detail as { persona?: StoredConversationPersona | null })
    .persona;
  if (!persona || typeof persona.name !== 'string' || !persona.name.trim()) {
    return null;
  }
  return persona;
}

export function getConversationSessionGoal(
  conversationId: string | null
): ConversationSessionGoal | null {
  if (!conversationId) return null;
  return state.byConversationId[conversationId]?.sessionGoal ?? null;
}

export function getConversationAsyncTasks(
  conversationId: string | null
): AsyncTaskRecord[] {
  if (!conversationId) return EMPTY_ASYNC_TASKS;
  return (
    state.byConversationId[conversationId]?.asyncTasks ?? EMPTY_ASYNC_TASKS
  );
}

export function getConversationBindReady(
  conversationId: string | null
): boolean {
  if (!conversationId) return false;
  return slots.get(conversationId)?.bindReady ?? false;
}

export function getConversationPromptSuggestion(
  conversationId: string | null
): string | null {
  if (!conversationId) return null;
  return state.byConversationId[conversationId]?.promptSuggestion ?? null;
}

export function clearConversationPromptSuggestion(
  conversationId: string | null
): void {
  if (!conversationId) return;
  dispatch({ type: 'clear_prompt_suggestion', conversationId });
}

function timelineTurnInFlight(rows: TimelineRow[] | undefined): boolean {
  return (rows ?? []).some(
    (row) =>
      row.row.kind === 'message_turn' &&
      (row.row.phase === 'streaming' || row.row.phase === 'optimistic')
  );
}

function buildSessionFacts(
  conversationId: string,
  entry: ConversationStoreState['byConversationId'][string] | undefined
): ConversationSessionFacts {
  const summary = entry?.detail?.summary;
  return {
    sessionId: conversationId,
    hasDetail: Boolean(entry?.detail),
    error: entry?.error ?? null,
    title: summary?.title ?? null,
    status: summary?.status ?? null,
    agentId: summary?.agent_id ?? null,
    model: summary?.model ?? null,
    acpSessionId: entry?.detail?.active_binding?.acp_session_id ?? null,
    externalSessionId: summary?.external_session_id ?? null,
    turnInFlight:
      Boolean(entry?.detail?.in_flight_user_turn_id) ||
      (entry?.optimisticTurns.length ?? 0) > 0 ||
      timelineTurnInFlight(entry?.rows),
    sessionStats: entry?.detail?.session_stats ?? null,
    truncated: Boolean(entry?.olderCursor),
    loading: entry?.loading ?? false,
  };
}

function areSessionFactsEqual(
  a: ConversationSessionFacts,
  b: ConversationSessionFacts
): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.hasDetail === b.hasDetail &&
    a.error === b.error &&
    a.title === b.title &&
    a.status === b.status &&
    a.agentId === b.agentId &&
    a.model === b.model &&
    a.acpSessionId === b.acpSessionId &&
    a.externalSessionId === b.externalSessionId &&
    a.turnInFlight === b.turnInFlight &&
    a.sessionStats === b.sessionStats &&
    a.truncated === b.truncated &&
    a.loading === b.loading
  );
}

export function syncConversationSelectedAgent(
  conversationId: string | null | undefined,
  nextAgentId: string | null | undefined
): void {
  const id = conversationId?.trim();
  const normalized = nextAgentId?.trim();
  if (!id || !normalized) return;
  const entry = state.byConversationId[id];
  if (!entry?.detail) return;
  const prevKey =
    normalizeAgentIdentity(
      entry.detail.summary.agent_id ??
        entry.detail.active_binding?.agent_type ??
        entry.controlsAgentId
    ) ?? '';
  const nextKey = normalizeAgentIdentity(normalized) ?? '';
  const controlsMismatch = Boolean(
    entry.controlsAgentId && entry.controlsAgentId !== nextKey
  );
  const changed = prevKey !== nextKey || controlsMismatch;
  if (!changed && entry.detail.summary.agent_id === normalized) return;
  const activeBindingMatchesNext =
    normalizeAgentIdentity(entry.detail.active_binding?.agent_type) === nextKey;
  state = {
    ...state,
    byConversationId: {
      ...state.byConversationId,
      [id]: {
        ...entry,
        detail: {
          ...entry.detail,
          active_binding: activeBindingMatchesNext
            ? entry.detail.active_binding
            : null,
          summary: {
            ...entry.detail.summary,
            agent_id: normalized,
            ...(changed ? { model: null, external_session_id: null } : {}),
          },
        },
        ...(changed
          ? {
              controlsAgentId: nextKey || null,
              sessionModes: EMPTY_SESSION_MODES,
              sessionConfigOptions: EMPTY_CONFIG_OPTIONS,
              availableCommands: null,
            }
          : {}),
      },
    },
  };
  if (changed) {
    const slot = slots.get(id);
    if (slot) {
      if (slot.connectionId) {
        (slot.retiredConnectionIds ??= new Set()).add(slot.connectionId);
        slot.connectionId = undefined;
      }
      slot.connectionSequence = undefined;
      slot.connectionStatus = undefined;
      slot.bindReady = false;
      slot.connecting = false;
      slot.staleBindRetries = 0;
      slot.bindGeneration = (slot.bindGeneration ?? 0) + 1;
      slot.keepalive?.();
      slot.keepalive = undefined;
      inflightBinds.delete(id);
      if (slot.controller && !slot.controller.stopped) {
        if (slot.controller.bindTimer != null) {
          window.clearTimeout(slot.controller.bindTimer);
          slot.controller.bindTimer = null;
        }
        slot.controller.cancelBindIdle?.();
        slot.controller.cancelBindIdle = null;
        if (slot.refs > 0 && canBind(id)) {
          beginBind(id);
        }
      }
    }
  }
  viewCache.delete(id);
  factsCache.delete(id);
  notify(id);
}

/** Stable snapshot for the session-details panel. Does not retain or refresh. */
export function getConversationSessionFacts(
  conversationId: string | null
): ConversationSessionFacts {
  if (!conversationId) return EMPTY_SESSION_FACTS;
  const entry = state.byConversationId[conversationId];
  const cached = factsCache.get(conversationId);
  if (cached && cached.entry === entry) return cached.facts;
  const facts = buildSessionFacts(conversationId, entry);
  if (cached && areSessionFactsEqual(cached.facts, facts)) {
    cached.entry = entry;
    return cached.facts;
  }
  factsCache.set(conversationId, { entry, facts });
  return facts;
}

export function getConversationTimelineView(
  conversationId: string | null
): ConversationTimelineView {
  if (!conversationId) return EMPTY_VIEW;
  const entry = state.byConversationId[conversationId];
  const slot = slots.get(conversationId);
  const bindReady = slot?.bindReady ?? false;
  const connecting = Boolean(
    slot?.connecting || inflightBinds.has(conversationId)
  );
  const connectionStatus = slot?.connectionStatus;
  const cached = viewCache.get(conversationId);
  if (
    cached &&
    cached.entry === entry &&
    cached.bindReady === bindReady &&
    cached.connecting === connecting &&
    cached.connectionStatus === connectionStatus
  ) {
    return cached.view;
  }
  const view = buildView(conversationId, entry, bindReady, connecting);
  viewCache.set(conversationId, {
    entry,
    bindReady,
    connecting,
    connectionStatus,
    view,
  });
  return view;
}

const MAX_INACTIVE_CACHED_CONVERSATIONS = 24;
const inactiveConversationLru: string[] = [];

function unmarkInactiveConversation(conversationId: string): void {
  const index = inactiveConversationLru.indexOf(conversationId);
  if (index >= 0) {
    inactiveConversationLru.splice(index, 1);
  }
}

function parkInactiveConversation(conversationId: string): void {
  const entry = state.byConversationId[conversationId];
  viewCache.delete(conversationId);
  factsCache.delete(conversationId);
  if (!entry?.detail) {
    unmarkInactiveConversation(conversationId);
    dispatch({ type: 'reset', conversationId });
    return;
  }
  state = {
    ...state,
    byConversationId: {
      ...state.byConversationId,
      [conversationId]: parkEntryWindowRows(entry),
    },
  };
  unmarkInactiveConversation(conversationId);
  inactiveConversationLru.push(conversationId);
  while (inactiveConversationLru.length > MAX_INACTIVE_CACHED_CONVERSATIONS) {
    const evictedId = inactiveConversationLru.shift();
    if (!evictedId) break;
    const evictedSlot = slots.get(evictedId);
    if (evictedSlot && (evictedSlot.refs > 0 || evictedSlot.surfaceRefs > 0)) {
      continue;
    }
    viewCache.delete(evictedId);
    factsCache.delete(evictedId);
    dispatch({ type: 'reset', conversationId: evictedId });
  }
}

function createSlot(): Slot {
  return {
    refs: 0,
    surfaceRefs: 0,
    bindReady: false,
    connecting: false,
    staleBindRetries: 0,
    controller: null,
  };
}

export function retainConversationSurface(conversationId: string): () => void {
  unmarkInactiveConversation(conversationId);
  let slot = slots.get(conversationId);
  if (!slot) {
    slot = createSlot();
    slots.set(conversationId, slot);
  }
  slot.surfaceRefs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseConversationSurface(conversationId);
  };
}

export function retainConversationTimeline(conversationId: string): () => void {
  unmarkInactiveConversation(conversationId);
  let slot = slots.get(conversationId);
  if (!slot) {
    slot = createSlot();
    slots.set(conversationId, slot);
  }
  slot.refs += 1;
  if (slot.refs === 1) {
    startController(conversationId, slot);
  } else if (slot.bindReady) {
    startKeepalive(conversationId, slot);
  } else if (slot.controller) {
    scheduleBind(conversationId, slot.controller);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseConversationTimeline(conversationId);
  };
}

export function resetConversationTimelineRegistryForTests(): void {
  for (const slot of slots.values()) stopController(slot);
  slots.clear();
  inflightBinds.clear();
  inactiveConversationLru.length = 0;
  viewCache.clear();
  factsCache.clear();
  state = emptyConversationStoreState;
  listeners.clear();
  listenersByConversation.clear();
  clearBufferedOptimisticConversationTurnsForTests();
}

function releaseConversationTimeline(conversationId: string): void {
  const slot = slots.get(conversationId);
  if (!slot) return;
  slot.refs = Math.max(0, slot.refs - 1);
  if (slot.refs > 0) return;
  stopController(slot);
  notify(conversationId);
  if (slot.surfaceRefs > 0) return;
  slots.delete(conversationId);
  parkInactiveConversation(conversationId);
}

function releaseConversationSurface(conversationId: string): void {
  const slot = slots.get(conversationId);
  if (!slot) return;
  slot.surfaceRefs = Math.max(0, slot.surfaceRefs - 1);
  if (slot.refs > 0 || slot.surfaceRefs > 0) return;
  stopController(slot);
  slots.delete(conversationId);
  parkInactiveConversation(conversationId);
}

function applyOptimisticTurnAdd(
  conversationId: string,
  turn: MessageTurn
): void {
  acknowledgeOptimisticConversationTurn(conversationId, turn.id);
  const slot = slots.get(conversationId);
  if (slot) {
    slot.staleBindRetries = 0;
  }
  const existing = state.byConversationId[conversationId]?.optimisticTurns;
  if (existing?.some((item) => item.id === turn.id)) return;
  dispatch({ type: 'optimistic_turn', conversationId, turn });
  if (slot && !slot.bindReady && !slot.connecting && slot.controller) {
    scheduleBind(conversationId, slot.controller);
  }
}

function startController(conversationId: string, slot: Slot): void {
  const controller: Controller = {
    stopped: false,
    loadEpoch: 0,
    preDetailBatches: [],
    pendingBatches: [],
    maxLiveSequenceSeen: 0n,
    flushFrame: null,
    flushTimer: null,
    bindTimer: null,
    cancelBindIdle: null,
    loadingOlder: false,
    loadOlderPromise: null,
    liveStarted: false,
    gapFetchedFor: null,
  };
  slot.controller = controller;
  slot.staleBindRetries = 0;
  controller.unlistenOptimistic = subscribeToOptimisticConversationTurns(
    (event) => {
      if (controller.stopped || event.conversationId !== conversationId) return;
      if (event.type === 'add') {
        applyOptimisticTurnAdd(event.conversationId, event.turn);
        return;
      }
      dispatch({
        type: 'remove_optimistic_turn',
        conversationId: event.conversationId,
        turnId: event.turnId,
      });
    }
  );
  for (const bufferedTurn of consumeBufferedOptimisticConversationTurns(
    conversationId
  )) {
    applyOptimisticTurnAdd(conversationId, bufferedTurn);
  }
  void listenToAgentEvents((envelope) => {
    if (controller.stopped || envelope.session_id !== conversationId) return;
    const current = slots.get(conversationId);
    if (!current || current.refs <= 0) return;
    let connectionChanged = false;
    if (
      envelope.event.kind === 'session_bind_ready' ||
      envelope.event.kind === 'connection_status_changed' ||
      envelope.event.kind === 'session_created'
    ) {
      const incomingConnectionId = envelope.connection_id;
      if (incomingConnectionId) {
        if (current.retiredConnectionIds?.has(incomingConnectionId)) return;
        if (
          current.connectionId &&
          current.connectionId !== incomingConnectionId
        ) {
          (current.retiredConnectionIds ??= new Set()).add(
            current.connectionId
          );
          current.connectionId = incomingConnectionId;
          current.connectionSequence = undefined;
          current.bindGeneration = (current.bindGeneration ?? 0) + 1;
          current.bindReady = false;
          current.connecting = true;
          current.staleBindRetries = 0;
          current.keepalive?.();
          current.keepalive = undefined;
          connectionChanged = true;
        } else if (!current.connectionId) {
          current.connectionId = incomingConnectionId;
        }
      }
      if (
        current.connectionSequence != null &&
        envelope.sequence != null &&
        envelope.sequence <= current.connectionSequence
      )
        return;
      if (envelope.sequence != null)
        current.connectionSequence = envelope.sequence;
    }
    if (envelope.event.kind === 'session_bind_ready') {
      current.bindGeneration = (current.bindGeneration ?? 0) + 1;
      current.connecting = false;
      current.staleBindRetries = 0;
      current.connectionStatus = 'ready';
      current.bindReady = true;
      if (current.controller) void loadDetail(conversationId, current.controller);
      notify(conversationId);
      startKeepalive(conversationId, current);
      return;
    }
    if (
      (envelope.event.kind === 'session_created' &&
        envelope.event.snapshot?.status === 'creating') ||
      (envelope.event.kind === 'connection_status_changed' &&
        envelope.event.snapshot.status !== 'ready')
    ) {
      const nextStatus: string =
        envelope.event.kind === 'connection_status_changed'
          ? envelope.event.snapshot.status
          : 'connecting';
      current.connectionStatus = nextStatus;
      current.connecting =
        nextStatus === 'connecting' || nextStatus === 'recovering';
      current.bindReady = false;
      current.bindGeneration = (current.bindGeneration ?? 0) + 1;
      current.keepalive?.();
      current.keepalive = undefined;
      notify(conversationId);
      return;
    }
    if (connectionChanged) {
      const nextStatus: string =
        envelope.event.kind === 'connection_status_changed'
          ? envelope.event.snapshot.status
          : 'connecting';
      current.connectionStatus = nextStatus;
      current.connecting =
        nextStatus === 'connecting' || nextStatus === 'recovering';
      notify(conversationId);
    }
  }).then((unsubscribe) => {
    if (controller.stopped) {
      unsubscribe();
      return;
    }
    controller.unlistenAgent = unsubscribe;
  });
  controller.unsubscribeStore = subscribeConversationTimeline(() => {
    watchGap(conversationId, controller);
  }, conversationId);
  void loadDetail(conversationId, controller);
}

function cancelScheduledFlush(controller: Controller): void {
  if (controller.flushFrame != null) {
    cancelAnimationFrame(controller.flushFrame);
    controller.flushFrame = null;
  }
  if (controller.flushTimer != null) {
    window.clearTimeout(controller.flushTimer);
    controller.flushTimer = null;
  }
}

function stopController(slot: Slot): void {
  const controller = slot.controller;
  slot.keepalive?.();
  slot.keepalive = undefined;
  slot.bindReady = false;
  slot.connecting = false;
  if (!controller) return;
  controller.stopped = true;
  controller.loadEpoch += 1;
  cancelScheduledFlush(controller);
  controller.preDetailBatches = [];
  controller.pendingBatches = [];
  if (controller.bindTimer != null) {
    window.clearTimeout(controller.bindTimer);
    controller.bindTimer = null;
  }
  controller.cancelBindIdle?.();
  controller.cancelBindIdle = null;
  controller.unlistenEvents?.();
  controller.unlistenAgent?.();
  controller.unlistenOptimistic?.();
  controller.unsubscribeStore?.();
  slot.controller = null;
}

const TAIL_TURNS = 120;

function prefixHashOf(
  detail: { prefix_hash?: string | null } | null | undefined
): string | null {
  return detail?.prefix_hash ?? null;
}

function replayPreDetailBatches(
  conversationId: string,
  controller: Controller,
  detailCursor: bigint
): boolean {
  const buffered = controller.preDetailBatches.splice(0);
  if (buffered.length === 0) return false;
  const ordered = buffered
    .map((item, index) => ({
      item,
      index,
      seq: toBigIntSeq(item.last_sequence, 0n),
    }))
    .sort((left, right) =>
      left.seq !== right.seq
        ? left.seq < right.seq
          ? -1
          : 1
        : left.index - right.index
    )
    .map((wrapped) => wrapped.item);
  let shouldResetResync = false;
  let replayedAny = false;
  for (const pending of ordered) {
    const batchSeq = toBigIntSeq(pending.last_sequence, 0n);
    const maxOpRev = pending.ops.reduce((max, op) => {
      const rev =
        op.op === 'upsert'
          ? toBigIntSeq(op.row.revision, 0n)
          : toBigIntSeq(op.revision, 0n);
      return rev > max ? rev : max;
    }, batchSeq);
    if (
      !isResetBatch(pending) &&
      batchSeq <= detailCursor &&
      maxOpRev <= detailCursor
    ) {
      continue;
    }
    if (isResetBatch(pending)) {
      shouldResetResync = true;
    }
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: pending,
    });
    replayedAny = true;
    watchGap(conversationId, controller);
  }
  if (replayedAny) {
    notify(conversationId);
  }
  return shouldResetResync;
}

function loadDetail(
  conversationId: string,
  controller: Controller,
  options?: { forceReplaceWindow?: boolean }
): Promise<void> {
  const epoch = ++controller.loadEpoch;
  const loaded = state.byConversationId[conversationId];
  const forceReplaceWindow = Boolean(options?.forceReplaceWindow);
  const fromIndex =
    !forceReplaceWindow && loaded?.loadedToStart ? 0 : undefined;
  const storedHash = forceReplaceWindow ? null : (loaded?.prefixHash ?? null);
  ensureLive(conversationId, controller);
  dispatch({ type: 'load_start', conversationId });
  const requested = conversationApi.detail(
    conversationId,
    fromIndex != null ? { fromIndex } : undefined
  );
  return requested
    .then(async (detail) => {
      if (controller.stopped || controller.loadEpoch !== epoch) return;
      if (!detail) {
        controller.preDetailBatches = [];
        dispatch({
          type: 'load_error',
          conversationId,
          error: 'Conversation not found',
        });
        return;
      }
      let resolved = detail;
      const returnedHash = prefixHashOf(
        detail as { prefix_hash?: string | null }
      );
      if (
        fromIndex != null &&
        storedHash &&
        returnedHash &&
        returnedHash !== storedHash
      ) {
        const tail = await conversationApi.detail(conversationId, {
          tailTurns: TAIL_TURNS,
        });
        if (controller.stopped || controller.loadEpoch !== epoch) return;
        if (tail) resolved = tail;
      }
      dispatch({
        type: 'load_success',
        conversationId,
        detail: resolved,
        forceReplaceWindow,
      });
      const detailCursor = toBigIntSeq(
        (resolved.timeline as { row_ops_cursor?: unknown }).row_ops_cursor ??
          resolved.timeline.last_sequence,
        0n
      );
      const shouldResetResync = replayPreDetailBatches(
        conversationId,
        controller,
        detailCursor
      );
      scheduleBind(conversationId, controller);
      if (shouldResetResync && !controller.stopped) {
        void loadDetail(conversationId, controller, { forceReplaceWindow: true });
      }
    })
    .catch((error: unknown) => {
      if (controller.stopped || controller.loadEpoch !== epoch) return;
      controller.preDetailBatches = [];
      report(conversationId, error);
    });
}

function flushPendingBatches(
  conversationId: string,
  controller: Controller
): void {
  cancelScheduledFlush(controller);
  if (controller.stopped) return;
  const batches = controller.pendingBatches;
  if (batches.length === 0) return;
  controller.pendingBatches = [];
  const coalesced = coalescePendingRowOpBatches(batches);
  let shouldResetResync = false;
  for (const pending of coalesced) {
    if (isResetBatch(pending)) {
      shouldResetResync = true;
    }
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: pending,
    });
    watchGap(conversationId, controller);
  }
  notify(conversationId);
  if (shouldResetResync && !controller.stopped) {
    void loadDetail(conversationId, controller, { forceReplaceWindow: true });
  }
}

function ensureLive(conversationId: string, controller: Controller): void {
  if (controller.liveStarted || controller.stopped) return;
  controller.liveStarted = true;
  void listenToConversationEvents((rawBatch) => {
    const batch = rawBatch as ResettableConversationRowOpBatch;
    if (controller.stopped || batch.conversation_id !== conversationId) return;
    const incomingSeq = toBigIntSeq(batch.last_sequence, 0n);
    if (incomingSeq > controller.maxLiveSequenceSeen) {
      controller.maxLiveSequenceSeen = incomingSeq;
    }
    if (!state.byConversationId[conversationId]?.detail) {
      controller.preDetailBatches.push(batch);
      return;
    }
    controller.pendingBatches.push(batch);
    const allPureAppend = controller.pendingBatches.every(isPureAppendBatch);
    if (!allPureAppend || hasTerminalTurnOp(batch) || isResetBatch(batch)) {
      if (controller.flushTimer != null) {
        flushPendingBatches(conversationId, controller);
        return;
      }
      if (controller.flushFrame == null) {
        controller.flushFrame = requestAnimationFrame(() => {
          flushPendingBatches(conversationId, controller);
        });
      }
      return;
    }
    if (controller.pendingBatches.length >= STREAM_QUEUE_CAP) {
      flushPendingBatches(conversationId, controller);
      return;
    }
    const liveChars = liveConversationChars(
      state.byConversationId[conversationId],
      controller.pendingBatches
    );
    if (liveChars > STREAM_FLUSH_CHARS_PER_FRAME) {
      if (controller.flushFrame != null) {
        cancelAnimationFrame(controller.flushFrame);
        controller.flushFrame = null;
      }
      if (controller.flushTimer == null) {
        const delay = streamFlushDelayMs(liveChars);
        controller.flushTimer = window.setTimeout(() => {
          flushPendingBatches(conversationId, controller);
        }, delay);
      }
      return;
    }
    if (controller.flushFrame == null && controller.flushTimer == null) {
      controller.flushFrame = requestAnimationFrame(() => {
        flushPendingBatches(conversationId, controller);
      });
    }
  }, conversationId)
    .then((unsubscribe) => {
      if (controller.stopped) {
        unsubscribe();
        return;
      }
      controller.unlistenEvents = unsubscribe;
    })
    .catch((error: unknown) => {
      if (controller.stopped) return;
      report(conversationId, error);
    });
}

function scheduleBind(
  conversationId: string,
  controller: Controller,
  retryDelayMs?: number
): void {
  const slot = slots.get(conversationId);
  if (!slot || controller.stopped || slot.bindReady) return;
  if (inflightBinds.has(conversationId)) {
    slot.connecting = true;
    notify(conversationId);
    return;
  }
  if (!canBind(conversationId)) return;
  slot.connecting = true;
  notify(conversationId);
  const start = () => {
    controller.cancelBindIdle = null;
    controller.bindTimer = null;
    if (controller.stopped) return;
    const current = slots.get(conversationId);
    if (!current || current.refs <= 0 || current.bindReady) return;
    if (inflightBinds.has(conversationId)) return;
    if (!canBind(conversationId)) {
      current.connecting = false;
      notify(conversationId);
      return;
    }
    beginBind(conversationId);
  };
  if (controller.bindTimer != null) {
    window.clearTimeout(controller.bindTimer);
  }
  controller.cancelBindIdle?.();
  controller.cancelBindIdle = null;
  if (retryDelayMs != null) {
    controller.bindTimer = window.setTimeout(start, retryDelayMs);
    return;
  }
  const idle = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof idle.requestIdleCallback === 'function') {
    controller.bindTimer = window.setTimeout(() => {
      controller.bindTimer = null;
      if (controller.stopped) return;
      const idleId = idle.requestIdleCallback!(start, { timeout: 300 });
      controller.cancelBindIdle = () => idle.cancelIdleCallback?.(idleId);
    }, 200);
    return;
  }
  controller.bindTimer = window.setTimeout(start, 0);
}

function beginBind(conversationId: string): void {
  if (inflightBinds.has(conversationId)) return;
  const startingSlot = slots.get(conversationId);
  if (!startingSlot) return;
  startingSlot.connecting = true;
  startingSlot.bindGeneration = (startingSlot.bindGeneration ?? 0) + 1;
  const bindGeneration = startingSlot.bindGeneration;
  const pending = conversationApi
    .ensureSessionControls(conversationId, { reload: false })
    .then((controls) => {
      if (inflightBinds.get(conversationId) === pending) {
        inflightBinds.delete(conversationId);
      }
      const current = slots.get(conversationId);
      if (
        !current ||
        current !== startingSlot ||
        current.refs <= 0 ||
        (current.bindGeneration ?? 0) !== bindGeneration
      ) {
        if (
          current === startingSlot &&
          !current.bindReady &&
          !inflightBinds.has(conversationId) &&
          current.connectionStatus !== 'connecting' &&
          current.connectionStatus !== 'recovering'
        ) {
          current.connecting = false;
        }
        notify(conversationId);
        return;
      }
      dispatch({
        type: 'session_controls_hydrated',
        conversationId,
        controls,
      });
      current.connecting = false;
      current.staleBindRetries = 0;
      current.bindReady = true;
      current.connectionStatus = 'ready';
      notify(conversationId);
      startKeepalive(conversationId, current);
    })
    .catch((error: unknown) => {
      if (inflightBinds.get(conversationId) === pending) {
        inflightBinds.delete(conversationId);
      }
      const current = slots.get(conversationId);
      if (
        !current ||
        current !== startingSlot ||
        current.refs <= 0 ||
        (current.bindGeneration ?? 0) !== bindGeneration
      ) {
        if (
          current === startingSlot &&
          !current.bindReady &&
          !inflightBinds.has(conversationId) &&
          current.connectionStatus !== 'connecting' &&
          current.connectionStatus !== 'recovering'
        ) {
          current.connecting = false;
        }
        notify(conversationId);
        return;
      }
      current.connecting = false;
      if (isStaleAgentConnectionError(error)) {
        if (
          current.staleBindRetries < MAX_STALE_BIND_RETRIES &&
          current.controller &&
          !current.controller.stopped
        ) {
          current.staleBindRetries += 1;
          scheduleBind(
            conversationId,
            current.controller,
            STALE_BIND_RETRY_DELAY_MS
          );
          return;
        }
        current.bindReady = false;
        notify(conversationId);
        return;
      }
      current.bindReady = false;
      notify(conversationId);
      report(conversationId, error);
    });
  inflightBinds.set(conversationId, pending);
  notify(conversationId);
}

function canBind(conversationId: string): boolean {
  const entry = state.byConversationId[conversationId];
  const skip = canSkipInFlightHistoryWait(
    entry?.detail?.active_binding?.capabilities
  );
  if (!entry?.detail && !skip) return false;
  if (!entry?.detail || entry.error) return false;
  if (!entry.detail.summary.workspace_id) return false;
  return !entry.rows.some(
    (row) => row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
  );
}

function startKeepalive(conversationId: string, slot: Slot): void {
  if (slot.keepalive || !slot.bindReady || slot.refs <= 0) return;
  slot.keepalive = retainConversationKeepalive(conversationId, (watch) =>
    conversationApi.touch(conversationId, watch)
  );
}

function isUnimplementedGapError(error: unknown): boolean {
  const message = getInvokeErrorMessage(error) ?? String(error ?? '');
  return /unknown command|not found|unimplemented|not implemented|404/i.test(
    message
  );
}

async function backfillSmallGap(
  conversationId: string,
  controller: Controller,
  afterSequence: bigint
): Promise<void> {
  const epoch = controller.loadEpoch;
  const api = conversationApi as typeof conversationApi & {
    rowsSince?: typeof conversationApi.rowsSince;
    eventsSince?: typeof conversationApi.eventsSince;
  };
  try {
    let normalized: {
      lastSequence: bigint;
      reset: boolean;
      ops: ConversationRowOp[];
    };
    if (typeof api.rowsSince === 'function') {
      const res = await api.rowsSince({
        conversationId,
        afterSequence,
        limit: 500,
      });
      normalized = normalizeGapPage(res, afterSequence);
    } else if (typeof api.eventsSince === 'function') {
      const res = await api.eventsSince({ conversationId, afterSequence });
      normalized = normalizeGapPage(res, afterSequence);
    } else {
      controller.gapFetchedFor = null;
      await loadDetail(conversationId, controller);
      return;
    }
    if (controller.stopped || controller.loadEpoch !== epoch) return;
    controller.gapFetchedFor = null;
    if (normalized.reset) {
      await loadDetail(conversationId, controller, {
        forceReplaceWindow: true,
      });
      return;
    }
    dispatch({
      type: 'apply_gap_rows',
      conversationId,
      ops: normalized.ops,
      lastSequence: normalized.lastSequence,
    });
    if (
      !controller.stopped &&
      controller.loadEpoch === epoch &&
      controller.maxLiveSequenceSeen > normalized.lastSequence &&
      normalized.lastSequence > afterSequence
    ) {
      void backfillSmallGap(conversationId, controller, normalized.lastSequence);
    }
  } catch (error: unknown) {
    if (controller.stopped || controller.loadEpoch !== epoch) return;
    controller.gapFetchedFor = null;
    if (isUnimplementedGapError(error)) {
      await loadDetail(conversationId, controller);
      return;
    }
    report(conversationId, error);
  }
}

function watchGap(conversationId: string, controller: Controller): void {
  if (controller.stopped) return;
  const gap = state.byConversationId[conversationId]?.gap;
  if (!gap || gap.kind !== 'gap') {
    controller.gapFetchedFor = null;
    return;
  }
  if (controller.gapFetchedFor === gap.expectedSequence) return;
  controller.gapFetchedFor = gap.expectedSequence;
  const gapSize = gap.receivedSequence - gap.expectedSequence;
  if (gapSize > SMALL_SEQUENCE_GAP_MAX) {
    void loadDetail(conversationId, controller, { forceReplaceWindow: true });
    return;
  }
  void backfillSmallGap(conversationId, controller, gap.expectedSequence - 1n);
}

function report(conversationId: string, error: unknown): void {
  const slot = slots.get(conversationId);
  if (!slot || slot.refs <= 0) return;
  dispatch({
    type: 'load_error',
    conversationId,
    error: conversationLoadError(error),
  });
}

async function resetAndReload(conversationId: string): Promise<void> {
  const controller = slots.get(conversationId)?.controller;
  if (!controller) return;
  if (controller.flushFrame != null) {
    cancelAnimationFrame(controller.flushFrame);
    controller.flushFrame = null;
  }
  controller.preDetailBatches = [];
  controller.pendingBatches = [];
  dispatch({ type: 'reset', conversationId });
  await loadDetail(conversationId, controller);
}

async function reconnectAndReload(conversationId: string): Promise<void> {
  const slot = slots.get(conversationId);
  if (!slot?.controller) return;
  slot.bindGeneration = (slot.bindGeneration ?? 0) + 1;
  const bindGeneration = slot.bindGeneration;
  slot.bindReady = false;
  slot.connecting = true;
  slot.staleBindRetries = 0;
  notify(conversationId);
  try {
    const controls = await conversationApi.ensureSessionControls(
      conversationId,
      { reload: true }
    );
    const current = slots.get(conversationId);
    if (
      !current ||
      current !== slot ||
      current.refs <= 0 ||
      (current.bindGeneration ?? 0) !== bindGeneration
    )
      return;
    dispatch({
      type: 'session_controls_hydrated',
      conversationId,
      controls,
    });
    current.connecting = false;
    current.bindReady = true;
    current.connectionStatus = 'ready';
    notify(conversationId);
    startKeepalive(conversationId, current);
    if (current.controller)
      await loadDetail(conversationId, current.controller);
  } catch (error: unknown) {
    const current = slots.get(conversationId);
    if (
      !current ||
      current !== slot ||
      current.refs <= 0 ||
      (current.bindGeneration ?? 0) !== bindGeneration
    )
      return;
    current.connecting = false;
    current.bindReady = false;
    notify(conversationId);
    report(conversationId, error);
  }
}

async function loadOlder(conversationId: string): Promise<void> {
  const controller = slots.get(conversationId)?.controller;
  if (!controller || controller.stopped) return;
  if (controller.loadOlderPromise) {
    await controller.loadOlderPromise;
    return;
  }
  const pageWindow = nextOlderTimelinePage(
    state.byConversationId[conversationId]?.olderCursor
  );
  if (!pageWindow) return;
  const epoch = controller.loadEpoch;
  controller.loadingOlder = true;
  const pending = (async () => {
    try {
      const page = await conversationApi.timelinePage({
        conversationId,
        cursor: pageWindow.cursor,
        limit: pageWindow.limit,
      });
      if (
        controller.stopped ||
        controller.loadEpoch !== epoch ||
        (slots.get(conversationId)?.refs ?? 0) <= 0
      ) {
        return;
      }
      const nextCursor =
        page.next_cursor != null && page.next_cursor.trim().length > 0
          ? page.next_cursor
          : null;
      dispatch({
        type: 'upsert_rows',
        conversationId,
        rows: page.rows,
        lastSequence:
          state.byConversationId[conversationId]?.lastSequence ?? 0n,
        olderCursor: nextCursor,
        protectLoaded: true,
      });
    } finally {
      controller.loadingOlder = false;
    }
  })();
  controller.loadOlderPromise = pending;
  try {
    await pending;
  } finally {
    if (controller.loadOlderPromise === pending) {
      controller.loadOlderPromise = null;
    }
  }
}

function buildView(
  conversationId: string,
  entry: ConversationStoreState['byConversationId'][string] | undefined,
  bindReady: boolean,
  slotConnecting: boolean
): ConversationTimelineView {
  const timeline = timelineTurnsForEntry(entry ?? null);
  const sideRows = sideRowsForEntry(entry ?? null);
  const items = timelineItemsForEntry(
    entry ?? null,
    undefined,
    timeline,
    sideRows
  );
  const hasDetail = Boolean(entry?.detail);
  return {
    timeline,
    items,
    sideRows,
    agentId: entry?.detail?.summary.agent_id ?? null,
    controlsAgentId: entry?.controlsAgentId ?? null,
    currentTurnId: entry?.currentTurnId ?? null,
    steeringSupported: Boolean(
      entry?.detail?.active_binding?.capabilities.steering
    ),
    deliveryChannel:
      entry?.detail?.active_binding?.capabilities.delivery_channel ?? 'none',
    forkSessionSupported: Boolean(
      entry?.detail?.active_binding?.capabilities.fork_session
    ),
    loading: entry?.loading ?? false,
    error: entry?.error ?? null,
    lastSequence: entry?.lastSequence ?? 0n,
    sessionModes: entry?.sessionModes ?? EMPTY_SESSION_MODES,
    sessionConfigOptions: entry?.sessionConfigOptions ?? EMPTY_CONFIG_OPTIONS,
    sessionGoal: entry?.sessionGoal ?? null,
    asyncTasks: entry?.asyncTasks ?? EMPTY_ASYNC_TASKS,
    promptSuggestion: entry?.promptSuggestion ?? null,
    goalControl: (action) =>
      conversationApi.goalControl(conversationId, action),
    stopAsyncTask: async (taskId) => {
      const res = await conversationApi.stopAsyncTask(conversationId, taskId);
      return Boolean(res?.stopped);
    },
    clearPromptSuggestion: () => {
      dispatch({ type: 'clear_prompt_suggestion', conversationId });
    },
    sendOptimisticTurn: (turn) => {
      applyOptimisticTurnAdd(conversationId, turn);
    },
    removeOptimisticTurn: (turnId) => {
      dispatch({ type: 'remove_optimistic_turn', conversationId, turnId });
    },
    refresh: () => {
      const controller = slots.get(conversationId)?.controller;
      if (controller) void loadDetail(conversationId, controller);
    },
    resetAndReload: () => resetAndReload(conversationId),
    reconnectAndReload: () => reconnectAndReload(conversationId),
    cancel: (reason) => conversationApi.cancel({ conversationId, reason }),
    respondPermission: (permissionId, response) =>
      conversationApi.respondPermission({
        conversationId,
        permissionId,
        response,
      }),
    respondQuestion: (questionId, response) =>
      conversationApi.respondQuestion({
        conversationId,
        questionId,
        response,
      }),
    hasEarlier: Boolean(entry?.olderCursor),
    loadOlder: () => loadOlder(conversationId),
    olderTurnsPrependEpoch: entry?.olderTurnsPrependEpoch ?? 0,
    userTurnsBeforeOffset: entry?.userTurnsBeforeOffset ?? 0,
    sessionBindReady: bindReady,
    connecting:
      hasDetail &&
      Boolean(entry?.detail?.summary.workspace_id) &&
      !bindReady &&
      slotConnecting &&
      !['failed', 'disconnected'].includes(
        slots.get(conversationId)?.connectionStatus ?? ''
      ) &&
      !entry?.error &&
      !(entry?.rows ?? []).some(
        (row) => row.row_id === AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
      ),
  };
}

function conversationLoadError(error: unknown): string | null {
  if (isCanceledError(error)) return null;
  return getInvokeErrorMessage(error);
}

function isStaleAgentConnectionError(error: unknown): boolean {
  const message = getInvokeErrorMessage(error) ?? '';
  return /agent connection `.+` was not found/i.test(message);
}
