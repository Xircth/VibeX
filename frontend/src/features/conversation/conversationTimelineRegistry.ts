import { getInvokeErrorMessage, isCanceledError } from '@/lib/errors';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  AgentSessionConfigOption,
  ConversationRowOpBatch,
  DeliveryChannel,
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
import { subscribeToOptimisticConversationTurns } from './optimisticTurnEvents';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
  timelineItemsForEntry,
  timelineTurnsForEntry,
  type ConversationSessionModesState,
  type ConversationStoreState,
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
} from './conversationStore';
import type { TimelineRow } from 'shared/types';

const EMPTY_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};
const EMPTY_CONFIG_OPTIONS: AgentSessionConfigOption[] = [];

type Controller = {
  stopped: boolean;
  loadEpoch: number;
  pendingBatches: ConversationRowOpBatch[];
  flushFrame: number | null;
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
  bindReady: boolean;
  keepalive?: () => void;
  controller: Controller | null;
};

export type ConversationTimelineView = {
  timeline: ConversationTimelineTurn[];
  items: ConversationTimelineItem[];
  sideRows: TimelineRow[];
  agentId: string | null;
  currentTurnId: string | null;
  steeringSupported: boolean;
  deliveryChannel: DeliveryChannel;
  forkSessionSupported: boolean;
  loading: boolean;
  error: string | null;
  lastSequence: bigint;
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
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
const slots = new Map<string, Slot>();
const inflightBinds = new Map<string, Promise<unknown>>();
const viewCache = new Map<
  string,
  {
    entry: ConversationStoreState['byConversationId'][string] | undefined;
    bindReady: boolean;
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
  currentTurnId: null,
  steeringSupported: false,
  deliveryChannel: 'none',
  forkSessionSupported: false,
  loading: false,
  error: null,
  lastSequence: 0n,
  sessionModes: EMPTY_SESSION_MODES,
  sessionConfigOptions: EMPTY_CONFIG_OPTIONS,
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

function notify(): void {
  for (const listener of listeners) listener();
}

function dispatch(
  action: Parameters<typeof conversationStoreReducer>[1]
): void {
  state = conversationStoreReducer(state, action);
  notify();
}

export function subscribeConversationTimeline(
  listener: () => void
): () => void {
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
  const persona = (
    detail as { persona?: StoredConversationPersona | null }
  ).persona;
  if (!persona || typeof persona.name !== 'string' || !persona.name.trim()) {
    return null;
  }
  return persona;
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

/** Stable snapshot for the session-details panel. Does not retain or refresh. */
export function getConversationSessionFacts(
  conversationId: string | null
): ConversationSessionFacts {
  if (!conversationId) return EMPTY_SESSION_FACTS;
  const entry = state.byConversationId[conversationId];
  const cached = factsCache.get(conversationId);
  if (cached && cached.entry === entry) return cached.facts;
  const facts = buildSessionFacts(conversationId, entry);
  factsCache.set(conversationId, { entry, facts });
  return facts;
}

export function getConversationTimelineView(
  conversationId: string | null
): ConversationTimelineView {
  if (!conversationId) return EMPTY_VIEW;
  const entry = state.byConversationId[conversationId];
  const bindReady = slots.get(conversationId)?.bindReady ?? false;
  const cached = viewCache.get(conversationId);
  if (cached && cached.entry === entry && cached.bindReady === bindReady) {
    return cached.view;
  }
  const view = buildView(conversationId, entry, bindReady);
  viewCache.set(conversationId, { entry, bindReady, view });
  return view;
}

export function retainConversationTimeline(conversationId: string): () => void {
  let slot = slots.get(conversationId);
  if (!slot) {
    slot = { refs: 0, bindReady: false, controller: null };
    slots.set(conversationId, slot);
  }
  slot.refs += 1;
  if (slot.refs === 1) {
    startController(conversationId, slot);
  } else if (slot.bindReady) {
    startKeepalive(conversationId, slot);
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
  viewCache.clear();
  factsCache.clear();
  state = emptyConversationStoreState;
  listeners.clear();
}

function releaseConversationTimeline(conversationId: string): void {
  const slot = slots.get(conversationId);
  if (!slot) return;
  slot.refs -= 1;
  if (slot.refs > 0) return;
  stopController(slot);
  slots.delete(conversationId);
  viewCache.delete(conversationId);
  factsCache.delete(conversationId);
  dispatch({ type: 'reset', conversationId });
}

function startController(conversationId: string, slot: Slot): void {
  const controller: Controller = {
    stopped: false,
    loadEpoch: 0,
    pendingBatches: [],
    flushFrame: null,
    bindTimer: null,
    cancelBindIdle: null,
    loadingOlder: false,
    loadOlderPromise: null,
    liveStarted: false,
    gapFetchedFor: null,
  };
  slot.controller = controller;
  controller.unlistenOptimistic = subscribeToOptimisticConversationTurns(
    (event) => {
      if (controller.stopped || event.conversationId !== conversationId) return;
      if (event.type === 'add') {
        dispatch({
          type: 'optimistic_turn',
          conversationId: event.conversationId,
          turn: event.turn,
        });
        return;
      }
      dispatch({
        type: 'remove_optimistic_turn',
        conversationId: event.conversationId,
        turnId: event.turnId,
      });
    }
  );
  void listenToAgentEvents((envelope) => {
    if (controller.stopped || envelope.session_id !== conversationId) return;
    if (envelope.event.kind !== 'session_bind_ready') return;
    const current = slots.get(conversationId);
    if (!current || current.refs <= 0) return;
    current.bindReady = true;
    notify();
    startKeepalive(conversationId, current);
  }).then((unsubscribe) => {
    if (controller.stopped) {
      unsubscribe();
      return;
    }
    controller.unlistenAgent = unsubscribe;
  });
  controller.unsubscribeStore = subscribeConversationTimeline(() => {
    watchGap(conversationId, controller);
  });
  void loadDetail(conversationId, controller);
}

function stopController(slot: Slot): void {
  const controller = slot.controller;
  slot.keepalive?.();
  slot.keepalive = undefined;
  slot.bindReady = false;
  if (!controller) return;
  controller.stopped = true;
  controller.loadEpoch += 1;
  if (controller.flushFrame != null) {
    cancelAnimationFrame(controller.flushFrame);
    controller.flushFrame = null;
  }
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

function loadDetail(
  conversationId: string,
  controller: Controller
): Promise<void> {
  const epoch = ++controller.loadEpoch;
  const loaded = state.byConversationId[conversationId];
  const fromIndexRaw =
    loaded?.olderCursor != null ? Number(loaded.olderCursor) : Number.NaN;
  const fromIndex = loaded?.loadedToStart
    ? 0
    : Number.isFinite(fromIndexRaw) && fromIndexRaw > 0
      ? fromIndexRaw
      : undefined;
  const storedHash = loaded?.prefixHash ?? null;
  dispatch({ type: 'load_start', conversationId });
  const requested = conversationApi.detail(
    conversationId,
    fromIndex != null ? { fromIndex } : undefined
  );
  return requested
    .then(async (detail) => {
      if (controller.stopped || controller.loadEpoch !== epoch) return;
      if (!detail) {
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
      dispatch({ type: 'load_success', conversationId, detail: resolved });
      ensureLive(conversationId, controller);
      scheduleBind(conversationId, controller);
    })
    .catch((error: unknown) => {
      if (controller.stopped || controller.loadEpoch !== epoch) return;
      report(conversationId, error);
    });
}

const TERMINAL_TURN_PHASES = new Set([
  'settled',
  'failed',
  'cancelled',
  'interrupted',
]);

function hasTerminalTurnOp(batch: ConversationRowOpBatch): boolean {
  return batch.ops.some(
    (op) =>
      op.op === 'upsert' &&
      ((op.row.row.kind === 'message_turn' &&
        TERMINAL_TURN_PHASES.has(op.row.row.phase)) ||
        op.row.row.kind === 'file_change_summary' ||
        op.row.row.kind === 'turn_error')
  );
}

function ensureLive(conversationId: string, controller: Controller): void {
  if (controller.liveStarted || controller.stopped) return;
  controller.liveStarted = true;
  void listenToConversationEvents((batch) => {
    if (controller.stopped || batch.conversation_id !== conversationId) return;
    controller.pendingBatches.push(batch);
    if (controller.flushFrame != null) return;
    controller.flushFrame = requestAnimationFrame(() => {
      controller.flushFrame = null;
      if (controller.stopped) return;
      const batches = controller.pendingBatches;
      if (batches.length === 0) return;
      controller.pendingBatches = [];
      let shouldReloadWindow = false;
      for (const pending of batches) {
        if (hasTerminalTurnOp(pending)) {
          shouldReloadWindow = true;
        }
        state = conversationStoreReducer(state, {
          type: 'row_ops',
          batch: pending,
        });
        watchGap(conversationId, controller);
      }
      notify();
      if (shouldReloadWindow && !controller.stopped) {
        void loadDetail(conversationId, controller);
      }
    });
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

function scheduleBind(conversationId: string, controller: Controller): void {
  const slot = slots.get(conversationId);
  if (!slot || controller.stopped || slot.bindReady) return;
  if (inflightBinds.has(conversationId)) return;
  if (!canBind(conversationId)) return;
  const start = () => {
    controller.cancelBindIdle = null;
    controller.bindTimer = null;
    if (controller.stopped) return;
    const current = slots.get(conversationId);
    if (!current || current.refs <= 0 || current.bindReady) return;
    if (inflightBinds.has(conversationId)) return;
    if (!canBind(conversationId)) return;
    beginBind(conversationId);
  };
  const idle = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof idle.requestIdleCallback === 'function') {
    const idleId = idle.requestIdleCallback(start, { timeout: 200 });
    controller.cancelBindIdle = () => idle.cancelIdleCallback?.(idleId);
    return;
  }
  controller.bindTimer = window.setTimeout(start, 0);
}

function beginBind(conversationId: string): void {
  if (inflightBinds.has(conversationId)) return;
  const pending = conversationApi
    .ensureSessionControls(conversationId, { reload: false })
    .then((controls) => {
      const current = slots.get(conversationId);
      if (!current || current.refs <= 0) return;
      dispatch({
        type: 'session_controls_hydrated',
        conversationId,
        controls,
      });
      current.bindReady = true;
      notify();
      startKeepalive(conversationId, current);
    })
    .catch((error: unknown) => {
      const current = slots.get(conversationId);
      if (!current || current.refs <= 0) return;
      if (isStaleAgentConnectionError(error)) return;
      current.bindReady = false;
      notify();
      report(conversationId, error);
    })
    .finally(() => {
      if (inflightBinds.get(conversationId) === pending) {
        inflightBinds.delete(conversationId);
      }
    });
  inflightBinds.set(conversationId, pending);
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

function watchGap(conversationId: string, controller: Controller): void {
  if (controller.stopped) return;
  const gap = state.byConversationId[conversationId]?.gap;
  if (!gap || gap.kind !== 'gap') {
    controller.gapFetchedFor = null;
    return;
  }
  if (controller.gapFetchedFor === gap.expectedSequence) return;
  controller.gapFetchedFor = gap.expectedSequence;
  void loadDetail(conversationId, controller);
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
  controller.pendingBatches = [];
  dispatch({ type: 'reset', conversationId });
  await loadDetail(conversationId, controller);
}

async function reconnectAndReload(conversationId: string): Promise<void> {
  const slot = slots.get(conversationId);
  if (!slot?.controller) return;
  slot.bindReady = false;
  notify();
  try {
    const controls = await conversationApi.ensureSessionControls(
      conversationId,
      { reload: true }
    );
    const current = slots.get(conversationId);
    if (!current || current.refs <= 0) return;
    dispatch({
      type: 'session_controls_hydrated',
      conversationId,
      controls,
    });
    current.bindReady = true;
    notify();
    startKeepalive(conversationId, current);
    if (current.controller)
      await loadDetail(conversationId, current.controller);
  } catch (error: unknown) {
    const current = slots.get(conversationId);
    if (!current || current.refs <= 0) return;
    current.bindReady = false;
    notify();
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
  controller.loadingOlder = true;
  const pending = (async () => {
    try {
      const page = await conversationApi.timelinePage({
        conversationId,
        cursor: String(pageWindow.start),
        limit: pageWindow.limit,
      });
      if (controller.stopped || slots.get(conversationId)?.refs === 0) return;
      const reportedStart =
        page.cursor != null && page.cursor !== ''
          ? Number(page.cursor)
          : pageWindow.start;
      const start = Number.isFinite(reportedStart)
        ? reportedStart
        : pageWindow.start;
      dispatch({
        type: 'upsert_rows',
        conversationId,
        rows: page.rows,
        lastSequence:
          state.byConversationId[conversationId]?.lastSequence ?? 0n,
        olderCursor: start > 0 ? String(start) : null,
        protectLoaded: true,
      });
    } finally {
      controller.loadingOlder = false;
      if (controller.loadOlderPromise === pending) {
        controller.loadOlderPromise = null;
      }
    }
  })();
  controller.loadOlderPromise = pending;
  await pending;
}

function buildView(
  conversationId: string,
  entry: ConversationStoreState['byConversationId'][string] | undefined,
  bindReady: boolean
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
    sendOptimisticTurn: (turn) => {
      dispatch({ type: 'optimistic_turn', conversationId, turn });
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
