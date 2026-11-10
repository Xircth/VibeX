import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import { Map as MapIcon, Wand2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import { useKanbanCanvasListVisible } from '@/lib/kanbanCanvasListVisible';
import { invalidateWorkspaceSessions } from '@/lib/sessionQueryCache';
import {
  clearCanvasReveal,
  peekCanvasReveal,
  subscribeCanvasReveal,
} from '@/lib/canvasSessionReveal';
import { sessionAttentionKind } from '@/components/kanban/session-hub/utils';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { cn } from '@/lib/utils';
import { FloatingSessionList } from './FloatingSessionList';
import { ImportRecentSessionsDialog } from './ImportRecentSessionsDialog';
import { SessionCanvasCardNode } from './SessionCanvasCardNode';
import { SessionCanvasDetailNode } from './SessionCanvasDetailNode';
import { SessionCanvasDock } from './SessionCanvasDock';
import { SessionCanvasGroupNode } from './SessionCanvasGroupNode';
import {
  applyAlignmentDeltaToOverlay,
  applyDragOverlayToCanvasNodes,
  applyDropHint,
  buildCanvasFlowLookups,
  computeDropHint,
  dragOverlayFromPositionChanges,
  canGroupSelection,
  collectSelectionForRemoval,
  excludeSelectedGroupChildren,
  expandSelectionToGroups,
  emptyGroupFootprint,
  findEmptyCanvasPlacement,
  lastSelectedCanvasSessionId,
  selectedSessionIdsForViewed,
  planSessionGrid,
  dropHintsEqual,
  flowPositionToWorld,
  groupSelection,
  importSessionsAsGroup,
  isGroupNode,
  isOverflowHidden,
  isSessionNode,
  nodeById,
  orderCanvasNodes,
  openSessionWindow,
  closeSessionWindow,
  createEmptyGroup,
  previewGroupFrame,
  previewCanvasDrop,
  nextOpenCardSlot,
  visualDropHint,
  renameGroup as renameCanvasGroup,
  toggleGroupShowAll as toggleCanvasGroupShowAll,
  resizeGroupFrame,
  inferGroupResizeAxis,
  toggleGroupCollapsed,
  worldRect,
  type CanvasDropHint,
  type CanvasFlowLookups,
  type GroupResizeOrigin,
} from './canvasGrouping';
import {
  canvasNodesMatch,
  CANVAS_HISTORY_LIMIT,
  snapshotCanvasNodes,
} from './canvasHistory';
import { SessionCanvasHistoryDock } from './SessionCanvasHistoryDock';
import { SessionCanvasViewportPanel } from './SessionCanvasViewportPanel';
import {
  BOARD_DOT_GAP,
  CANVAS_HANDLE_SIDES,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  canvasDropOrigin,
  collapsedSessionCardSize,
  DRAG_HANDLE_SELECTOR,
  alignGuidesEqual,
  applyMoves,
  canvasNodeId,
  computeAlignment,
  createCanvasNode,
  createCanvasPanelNode,
  handleAnchor,
  isPanelCanvasNode,
  nextDropPoint,
  packLayout,
  parseCanvasNodeId,
  canvasWindowSlotIndex,
  displayedCanvasNodes,
  flowNodeBox,
  openWindowSessionIds,
  preferLiveKanbanSessions,
  removeCanvasNode,
  resetNodeSize,
  resizeNode,
  reuseSetIfEqual,
  reuseStringListIfEqual,
  reuseUnchangedFlowNode,
  applyDragOverlayToFlowNode,
  canvasHasLiveSurfaces,
  sameSessionLinks,
  sizeForNode,
  type AlignmentGuide,
  type CanvasHandleSide,
  type CanvasRect,
  type CanvasNodeGeometry,
  type SessionCanvasLink,
  type SessionCanvasNode,
} from './canvasModel';
import {
  CANVAS_BUNDLE_KEY,
  canvasDocumentStorageKey,
  flushCanvasDocumentPersist,
  loadCanvasDocument,
  saveCanvasDocument,
  type SessionCanvasDocument,
  type SessionCanvasViewport,
} from './canvasStorage';
import {
  SessionCanvasViewProvider,
  type SessionCanvasViewContextValue,
} from './CanvasViewContext';
import { createCanvasSessionStore } from './canvasSessionStore';
import {
  consumeCanvasParentNodeId,
  registerCanvasWorkspaceController,
  type OpenCanvasPanelRequest,
  type OpenCanvasSessionRequest,
} from './canvasWorkspaceBridge';
import { useCanvasMarqueeTextGuard } from './useCanvasMarqueeTextGuard';
import { useCanvasRightDragPan } from './useCanvasRightDragPan';

const NODE_TYPES = {
  sessionCard: SessionCanvasCardNode,
  sessionDetail: SessionCanvasDetailNode,
  sessionGroup: SessionCanvasGroupNode,
} as unknown as NodeTypes;

const VIEWPORT_SAVE_DELAY_MS = 500;
const ALIGN_TOLERANCE_PX = 6;

export interface SessionCanvasApi {
  addOrFocus: (session: KanbanProjectSessionRecord) => void;
  addSession: (
    sessionId: string,
    options?: string | null | { parentNodeId?: string | null; expanded?: boolean }
  ) => SessionCanvasNode;
  dropSessionAt: (
    sessionId: string,
    client: { x: number; y: number },
    cardWidth?: number | null
  ) => void;
  presentSessionIds: () => Set<string>;
  removeSession: (sessionId: string) => void;
  openOrFocusPanel: (request: OpenCanvasPanelRequest) => string;
  openOrFocusSession: (request: OpenCanvasSessionRequest) => string;
}

interface SessionCanvasViewProps {
  projectId: string;
  sessions: KanbanProjectSessionRecord[];
  sessionsReady?: boolean;
  listWidth: number;
  list: ReactNode;
  hideSessionList?: boolean;
  createPanel?: ReactNode;
  projectName?: string;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>;
  onArchiveSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onApiReady?: (api: SessionCanvasApi) => void;
  onPresentIdsChange?: (sessionIds: string[]) => void;
  onWindowSessionIdsChange?: (sessionIds: string[]) => void;
  onCreateSession?: () => void;
  onCreateSessionWithExecutor?: (executor: string) => void;
  onSelectedSessionChange?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
}

function toFlowNode(
  node: SessionCanvasNode,
  nodes: readonly SessionCanvasNode[],
  lookups: CanvasFlowLookups,
  selectedIds: ReadonlySet<string>,
  dropHint: CanvasDropHint | null,
  windowSessionIds: readonly string[],
  runningSessionIds: ReadonlySet<string>
): Node {
  const size = sizeForNode(node);
  const parent =
    node.parentId && !node.expanded
      ? nodeById(nodes, node.parentId)
      : undefined;
  const position = { x: node.x, y: node.y };
  const isDropTarget =
    dropHint?.type === 'group' && dropHint.groupId === node.id;
  const zIndex = lookups.zIndex(node);
  if (isGroupNode(node)) {
    const count = lookups.sessionCount(node.id);
    const plan = planSessionGrid(count, node);
    const placeholder = isDropTarget ? nextOpenCardSlot(nodes, node.id) : null;
    const min = lookups.minSize(node.id);
    return {
      id: canvasNodeId(node.id),
      type: 'sessionGroup',
      position,
      ...flowNodeBox(size),
      selected: selectedIds.has(node.id),
      parentId: parent ? canvasNodeId(parent.id) : undefined,
      className: cn(
        'canvas-group-flow-node',
        isDropTarget && 'canvas-drop-target'
      ),
      zIndex,
      data: {
        instanceId: node.id,
        name: node.name,
        index: lookups.groupNumber(node.id),
        count,
        overflow: plan.overflow,
        placeholderX: placeholder?.x,
        placeholderY: placeholder?.y,
        showAll: node.showAll,
        collapsed: node.collapsed === true,
        isRunning: lookups.groupRunning(node.id),
        isReviewing: lookups.groupReviewing(node.id),
        minWidth: min.width,
        minHeight: min.height,
      },
    };
  }
  const slotIndex = node.sessionId
    ? canvasWindowSlotIndex(node.sessionId, windowSessionIds)
    : null;
  return {
    id: canvasNodeId(node.id),
    type: node.expanded ? 'sessionDetail' : 'sessionCard',
    position,
    ...flowNodeBox(size),
    selected: selectedIds.has(node.id),
    parentId: parent ? canvasNodeId(parent.id) : undefined,
    hidden: isOverflowHidden(nodes, node),
    dragHandle: node.expanded ? DRAG_HANDLE_SELECTOR : undefined,
    className: isDropTarget ? 'canvas-drop-target' : undefined,
    zIndex,
    data: {
      sessionId: node.sessionId,
      instanceId: node.id,
      slotIndex,
      isRunning: Boolean(
        node.sessionId && runningSessionIds.has(node.sessionId)
      ),
      panelId: node.panelId,
      panelComponent: node.panelComponent,
      panelTitle: node.panelTitle ?? node.name,
      panelParams: node.panelParams,
    },
  };
}

function linkAnchor(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode,
  side?: CanvasHandleSide
): { x: number; y: number } {
  const rect = worldRect(nodes, node);
  if (side) {
    return handleAnchor(rect, side);
  }
  if (node.expanded) {
    return { x: rect.x + rect.width / 2, y: rect.y + CARD_HEIGHT / 2 };
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function nearestHandleSide(
  rect: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number }
): CanvasHandleSide {
  let bestSide: CanvasHandleSide = 'left';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const side of CANVAS_HANDLE_SIDES) {
    const anchor = handleAnchor(rect, side);
    const dist = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestSide = side;
    }
  }
  return bestSide;
}

function childPlacementNearParent(
  nodes: readonly SessionCanvasNode[],
  parentNode: SessionCanvasNode,
  size: { width: number; height: number }
): { x: number; y: number } {
  const parentRect = worldRect(nodes, parentNode);
  const preferred = {
    x: parentRect.x + parentRect.width + 24,
    y: parentRect.y,
  };
  return findEmptyCanvasPlacement(nodes, size, preferred);
}

function SessionCanvasFlow({
  projectId,
  sessions,
  sessionsReady = true,
  listWidth,
  list,
  hideSessionList = false,
  createPanel = null,
  projectName = '',
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  onApiReady,
  onPresentIdsChange,
  onWindowSessionIdsChange,
  onCreateSession,
  onCreateSessionWithExecutor,
  onSelectedSessionChange,
}: SessionCanvasViewProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const queryClient = useQueryClient();
  const listVisible = useKanbanCanvasListVisible();
  const { fitView, setCenter, screenToFlowPosition, getViewport, setViewport } =
    useReactFlow();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onMiddleClickRef = useRef<(event: MouseEvent) => void>(() => {});
  const onMiddleClick = useCallback((event: MouseEvent) => {
    onMiddleClickRef.current(event);
  }, []);
  const rightPanOriginRef = useRef<{
    gestureId: number;
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
  const onRightPan = useCallback(
    (delta: { x: number; y: number; gestureId: number }) => {
      let origin = rightPanOriginRef.current;
      if (origin == null || origin.gestureId !== delta.gestureId) {
        const viewport = getViewport();
        origin = {
          gestureId: delta.gestureId,
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        };
        rightPanOriginRef.current = origin;
      }
      void setViewport({
        x: origin.x + delta.x,
        y: origin.y + delta.y,
        zoom: origin.zoom,
      });
    },
    [getViewport, setViewport]
  );
  useCanvasRightDragPan(surfaceRef, onMiddleClick, onRightPan);
  useCanvasMarqueeTextGuard(surfaceRef);

  const [documentState, setDocumentState] = useState<SessionCanvasDocument>(
    () => loadCanvasDocument(projectId)
  );

  useEffect(() => {
    const reload = (event?: StorageEvent) => {
      if (
        event &&
        event.key !== null &&
        event.key !== canvasDocumentStorageKey(projectId) &&
        event.key !== CANVAS_BUNDLE_KEY
      ) {
        return;
      }
      setDocumentState(loadCanvasDocument(projectId));
    };
    reload();
    window.addEventListener('storage', reload);
    return () => window.removeEventListener('storage', reload);
  }, [projectId]);
  const [importMode, setImportMode] = useState<
    'recent' | 'project' | 'agent' | null
  >(null);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const [dropHint, setDropHint] = useState<CanvasDropHint | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverlay, setDragOverlay] = useState<
    ReadonlyMap<string, { x: number; y: number }>
  >(() => new Map());
  const dragOverlayRef = useRef(dragOverlay);
  dragOverlayRef.current = dragOverlay;
  const [alignGuides, setAlignGuides] = useState<AlignmentGuide[]>([]);
  const [, setHistoryVersion] = useState(0);
  const historyRef = useRef<{
    past: SessionCanvasNode[][];
    future: SessionCanvasNode[][];
  }>({ past: [], future: [] });
  const skipHistoryRef = useRef(false);
  const marqueeSelectingRef = useRef(false);
  useLayoutEffect(() => {
    onMiddleClickRef.current = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (selectedIdsRef.current.size === 0) {
        setSelectionMenu(null);
        return;
      }
      setSelectionMenu({ x: event.clientX, y: event.clientY });
    };
  }, []);

  const altHeldRef = useRef(false);
  useEffect(() => {
    const sync = (event: KeyboardEvent) => {
      altHeldRef.current = event.altKey;
    };
    const clear = () => {
      altHeldRef.current = false;
    };
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', clear);
    };
  }, []);
  const alignCandidatesRef = useRef<CanvasRect[]>([]);
  const alignPrimaryRef = useRef<{
    id: string;
    width: number;
    height: number;
  } | null>(null);
  const flowNodeCacheRef = useRef(new Map<string, Node>());
  const zoomRef = useRef(documentState.viewport?.zoom ?? 1);
  const pendingViewport = useRef<Viewport | null>(documentState.viewport);
  const [heldSessionIds, setHeldSessionIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const liveIdsRef = useRef<ReadonlySet<string>>(new Set());
  const runningIdsRef = useRef<ReadonlySet<string>>(new Set());
  const reviewIdsRef = useRef<ReadonlySet<string>>(new Set());
  const windowSessionIdsRef = useRef<readonly string[]>([]);
  const presentIdsKeyRef = useRef('');
  const windowIdsKeyRef = useRef('');
  const saveTimer = useRef<number | null>(null);
  const documentRef = useRef(documentState);
  documentRef.current = documentState;
  const groupResizeOriginRef = useRef<
    (GroupResizeOrigin & { id: string }) | null
  >(null);

  const sessionStoreRef = useRef(createCanvasSessionStore());
  const previousLiveSessionsRef =
    useRef<readonly KanbanProjectSessionRecord[]>(sessions);
  const displaySessions = preferLiveKanbanSessions(
    sessions,
    previousLiveSessionsRef.current
  );
  if (displaySessions !== previousLiveSessionsRef.current) {
    previousLiveSessionsRef.current = displaySessions;
  }
  const liveIds = reuseSetIfEqual(
    liveIdsRef.current,
    new Set(displaySessions.map((session) => session.id))
  );
  liveIdsRef.current = liveIds;
  const sessionsById = useMemo(
    () => new Map(displaySessions.map((session) => [session.id, session])),
    [displaySessions]
  );

  const writeDocument = useCallback(
    (next: SessionCanvasDocument, persistToDisk: boolean) => {
      documentRef.current = next;
      setDocumentState(next);
      if (persistToDisk) saveCanvasDocument(projectId, next);
    },
    [projectId]
  );

  const persist = useCallback(
    (next: SessionCanvasDocument) => {
      writeDocument(next, true);
    },
    [writeDocument]
  );

  const nodes = useMemo(
    () =>
      displayedCanvasNodes(
        documentState.nodes,
        liveIds,
        sessionsReady,
        heldSessionIds
      ),
    [documentState.nodes, heldSessionIds, liveIds, sessionsReady]
  );
  const windowSessionIds = reuseStringListIfEqual(
    windowSessionIdsRef.current,
    openWindowSessionIds(nodes)
  );
  windowSessionIdsRef.current = windowSessionIds;
  const runningSessionIds = (() => {
    const ids = new Set<string>();
    for (const session of sessionsById.values()) {
      if (sessionAttentionKind(session) === 'running') ids.add(session.id);
    }
    const stable = reuseSetIfEqual(runningIdsRef.current, ids);
    runningIdsRef.current = stable;
    return stable;
  })();
  const reviewSessionIds = (() => {
    const ids = new Set<string>();
    for (const session of sessionsById.values()) {
      if (sessionAttentionKind(session) === 'review') ids.add(session.id);
    }
    const stable = reuseSetIfEqual(reviewIdsRef.current, ids);
    reviewIdsRef.current = stable;
    return stable;
  })();
  sessionStoreRef.current.replace(sessionsById, sessionsReady);
  const sessionsByIdRef = useRef(sessionsById);
  sessionsByIdRef.current = sessionsById;
  const onSelectedSessionChangeRef = useRef(onSelectedSessionChange);
  onSelectedSessionChangeRef.current = onSelectedSessionChange;
  // A catalog refresh replaces the session map without a new canvas selection.
  // Publishing that again puts the hidden canvas card back into the workspace
  // execution area after the session list has already switched.
  const pendingCanvasSelectionIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const notify = onSelectedSessionChangeRef.current;
    if (!notify) return;
    const sessionId = lastSelectedCanvasSessionId(
      documentRef.current.nodes,
      selectedIds
    );
    if (!sessionId) {
      pendingCanvasSelectionIdRef.current = null;
      return;
    }
    const session = sessionsByIdRef.current.get(sessionId);
    if (!session) {
      pendingCanvasSelectionIdRef.current = sessionId;
      return;
    }
    pendingCanvasSelectionIdRef.current = null;
    notify(session.placement);
  }, [selectedIds]);

  useLayoutEffect(() => {
    const sessionId = pendingCanvasSelectionIdRef.current;
    const notify = onSelectedSessionChangeRef.current;
    if (!sessionId || !notify) return;
    const session = sessionsById.get(sessionId);
    if (!session) return;
    pendingCanvasSelectionIdRef.current = null;
    notify(session.placement);
  }, [sessionsById]);

  useEffect(() => {
    const sessionIds = selectedSessionIdsForViewed(
      documentRef.current.nodes,
      selectedIds
    );
    if (sessionIds.length === 0) return;
    let cancelled = false;
    void Promise.all(
      sessionIds.map(async (sessionId) => {
        const session = sessionsById.get(sessionId);
        if (!session) return;
        await sessionsApi.markViewed(sessionId);
        if (!cancelled) {
          await invalidateWorkspaceSessions(queryClient, session.workspace.id);
        }
      })
    ).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [queryClient, selectedIds, sessionsById, runningSessionIds]);

  useEffect(() => {
    if (nodes.length === documentState.nodes.length) return;
    persist({ ...documentRef.current, nodes });
  }, [documentState.nodes.length, nodes, persist]);

  const updateNodes = useCallback(
    (
      mutate: (current: SessionCanvasNode[]) => SessionCanvasNode[],
      persistToDisk = true
    ) => {
      const current = documentRef.current;
      const nextNodes = mutate(current.nodes);
      if (
        persistToDisk &&
        !skipHistoryRef.current &&
        !canvasNodesMatch(current.nodes, nextNodes)
      ) {
        const history = historyRef.current;
        history.past = [
          ...history.past,
          snapshotCanvasNodes(current.nodes),
        ].slice(-CANVAS_HISTORY_LIMIT);
        history.future = [];
        setHistoryVersion((value) => value + 1);
      }
      writeDocument({ ...current, nodes: nextNodes }, persistToDisk);
    },
    [writeDocument]
  );

  const undoCanvas = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous) return;
    history.future = [
      snapshotCanvasNodes(documentRef.current.nodes),
      ...history.future,
    ].slice(0, CANVAS_HISTORY_LIMIT);
    skipHistoryRef.current = true;
    writeDocument({ ...documentRef.current, nodes: previous }, true);
    skipHistoryRef.current = false;
    setSelectedIds(new Set());
    setSelectionMenu(null);
    setHistoryVersion((value) => value + 1);
  }, [writeDocument]);

  const redoCanvas = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.shift();
    if (!next) return;
    history.past = [
      ...history.past,
      snapshotCanvasNodes(documentRef.current.nodes),
    ].slice(-CANVAS_HISTORY_LIMIT);
    skipHistoryRef.current = true;
    writeDocument({ ...documentRef.current, nodes: next }, true);
    skipHistoryRef.current = false;
    setSelectedIds(new Set());
    setSelectionMenu(null);
    setHistoryVersion((value) => value + 1);
  }, [writeDocument]);

  const layoutNodes = useMemo(
    () => previewCanvasDrop(nodes, draggedId, dropHint),
    [draggedId, dropHint, nodes]
  );

  const liveNodes = useMemo(
    () => applyDragOverlayToCanvasNodes(layoutNodes, dragOverlay),
    [dragOverlay, layoutNodes]
  );

  const rfNodes = useMemo(() => {
    const cache = flowNodeCacheRef.current;
    const nextCache = new Map<string, Node>();
    const lookups = buildCanvasFlowLookups(layoutNodes, {
      draggedId,
      selectedIds,
      runningSessionIds,
      reviewSessionIds,
    });
    const result = orderCanvasNodes(layoutNodes).map((node) => {
      const built = toFlowNode(
        node,
        layoutNodes,
        lookups,
        selectedIds,
        dropHint,
        windowSessionIds,
        runningSessionIds
      );
      const overlaid = applyDragOverlayToFlowNode(built, dragOverlay);
      const reused = reuseUnchangedFlowNode(cache.get(overlaid.id), overlaid);
      nextCache.set(reused.id, reused);
      return reused;
    });
    flowNodeCacheRef.current = nextCache;
    return result;
  }, [
    dragOverlay,
    draggedId,
    dropHint,
    layoutNodes,
    reviewSessionIds,
    runningSessionIds,
    selectedIds,
    windowSessionIds,
  ]);

  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const [connectingState, setConnectingState] = useState<{
    sourceId: string;
    sourceHandle: CanvasHandleSide;
    currentFlowPoint: { x: number; y: number };
    hoveredTarget: { nodeId: string; side: CanvasHandleSide } | null;
  } | null>(null);
  const connectingRef = useRef(connectingState);
  connectingRef.current = connectingState;

  const autoSessionLinks = useMemo(
    () =>
      sameSessionLinks(
        layoutNodes.filter((node) => !isOverflowHidden(layoutNodes, node))
      ),
    [layoutNodes]
  );

  const sessionLinks = useMemo(() => {
    const dismissed = new Set(documentState.dismissedAutoLinks ?? []);
    const custom = documentState.links ?? [];
    const merged = new Map<string, SessionCanvasLink>();
    for (const link of autoSessionLinks) {
      if (!dismissed.has(link.id)) {
        merged.set(link.id, link);
      }
    }
    for (const link of custom) {
      merged.set(link.id, link);
    }
    return [...merged.values()];
  }, [autoSessionLinks, documentState.dismissedAutoLinks, documentState.links]);

  const addLinkToDocument = useCallback(
    (
      sourceId: string,
      targetId: string,
      sourceHandle?: CanvasHandleSide,
      targetHandle?: CanvasHandleSide
    ) => {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const id =
        sourceHandle || targetHandle
          ? `link:${sourceId}:${sourceHandle ?? 'center'}:${targetId}:${targetHandle ?? 'center'}`
          : `link:${sourceId}:${targetId}`;
      const current = documentRef.current;
      const existingLinks = current.links ?? [];
      const dismissed = (current.dismissedAutoLinks ?? []).filter(
        (item) => item !== id && item !== `link:${sourceId}:${targetId}`
      );
      const alreadyExists = existingLinks.some((item) => item.id === id);
      const nextLinks = alreadyExists
        ? existingLinks
        : [
            ...existingLinks,
            {
              id,
              sourceId,
              targetId,
              ...(sourceHandle ? { sourceHandle } : {}),
              ...(targetHandle ? { targetHandle } : {}),
            },
          ];
      persist({
        ...current,
        links: nextLinks,
        dismissedAutoLinks: dismissed,
      });
    },
    [persist]
  );

  const disconnectLink = useCallback(
    (link: SessionCanvasLink) => {
      const current = documentRef.current;
      const nextLinks = (current.links ?? []).filter(
        (item) => item.id !== link.id
      );
      const dismissedSet = new Set(current.dismissedAutoLinks ?? []);
      if (autoSessionLinks.some((item) => item.id === link.id)) {
        dismissedSet.add(link.id);
      }
      persist({
        ...current,
        links: nextLinks,
        dismissedAutoLinks: [...dismissedSet],
      });
      setHoveredLinkId((prev) => (prev === link.id ? null : prev));
    },
    [autoSessionLinks, persist]
  );

  const beginHandleConnect = useCallback(
    (
      nodeId: string,
      side: CanvasHandleSide,
      clientX: number,
      clientY: number
    ) => {
      const flowPoint = screenToFlowPosition({ x: clientX, y: clientY });
      setConnectingState({
        sourceId: nodeId,
        sourceHandle: side,
        currentFlowPoint: flowPoint,
        hoveredTarget: null,
      });
    },
    [screenToFlowPosition]
  );

  const hoverHandleTarget = useCallback(
    (targetId: string | null, targetSide: CanvasHandleSide | null) => {
      setConnectingState((prev) =>
        prev
          ? {
              ...prev,
              hoveredTarget:
                targetId && targetSide
                  ? { nodeId: targetId, side: targetSide }
                  : null,
            }
          : null
      );
    },
    []
  );

  const completeHandleConnect = useCallback(
    (targetNodeId: string, targetSide: CanvasHandleSide) => {
      const active = connectingRef.current;
      connectingRef.current = null;
      setConnectingState(null);
      if (!active || active.sourceId === targetNodeId) return;
      addLinkToDocument(
        active.sourceId,
        targetNodeId,
        active.sourceHandle,
        targetSide
      );
    },
    [addLinkToDocument]
  );

  useEffect(() => {
    if (!connectingState) return;
    const onPointerMove = (event: PointerEvent) => {
      const flowPoint = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setConnectingState((prev) =>
        prev ? { ...prev, currentFlowPoint: flowPoint } : null
      );
    };
    const onPointerUp = (event: PointerEvent) => {
      const active = connectingRef.current;
      connectingRef.current = null;
      setConnectingState(null);
      if (!active) return;
      if (
        active.hoveredTarget &&
        active.hoveredTarget.nodeId !== active.sourceId
      ) {
        addLinkToDocument(
          active.sourceId,
          active.hoveredTarget.nodeId,
          active.sourceHandle,
          active.hoveredTarget.side
        );
        return;
      }
      const hitElement =
        typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(event.clientX, event.clientY)
          : (event.target as Element | null);
      const handleEl = hitElement?.closest?.('[data-canvas-handle-side]');
      if (handleEl) {
        const targetNodeId = handleEl.getAttribute('data-canvas-node-id');
        const targetSide = handleEl.getAttribute(
          'data-canvas-handle-side'
        ) as CanvasHandleSide | null;
        if (
          targetNodeId &&
          targetSide &&
          targetNodeId !== active.sourceId
        ) {
          addLinkToDocument(
            active.sourceId,
            targetNodeId,
            active.sourceHandle,
            targetSide
          );
          return;
        }
      }
      const nodeEl = hitElement?.closest?.('[data-canvas-instance-id]');
      if (nodeEl) {
        const targetNodeId = nodeEl.getAttribute('data-canvas-instance-id');
        if (targetNodeId && targetNodeId !== active.sourceId) {
          const targetNode = nodeById(documentRef.current.nodes, targetNodeId);
          if (targetNode) {
            const flowPoint = screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            });
            const targetSide = nearestHandleSide(
              worldRect(documentRef.current.nodes, targetNode),
              flowPoint
            );
            addLinkToDocument(
              active.sourceId,
              targetNodeId,
              active.sourceHandle,
              targetSide
            );
          }
        }
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [addLinkToDocument, connectingState, screenToFlowPosition]);

  const presentSessionIds = useCallback(
    () =>
      new Set(
        documentRef.current.nodes
          .filter(isSessionNode)
          .map((node) => node.sessionId)
      ),
    []
  );

  const holdSessionId = useCallback((sessionId: string) => {
    setHeldSessionIds((current) => {
      if (current.has(sessionId)) return current;
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  }, []);

  const canvasFlowCenter = useCallback(() => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return screenToFlowPosition(
      rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    );
  }, [screenToFlowPosition]);

  const currentCanvasZoom = useCallback(() => {
    const zoom = getViewport().zoom;
    zoomRef.current = zoom;
    return zoom;
  }, [getViewport]);

  const focusCanvasNode = useCallback(
    (node: SessionCanvasNode) => {
      const rect = worldRect(documentRef.current.nodes, node);
      const zoom = currentCanvasZoom();
      void setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, {
        duration: 280,
        zoom,
      });
    },
    [currentCanvasZoom, setCenter]
  );

  const addSession = useCallback(
    (
      sessionId: string,
      options?:
        | string
        | null
        | { parentNodeId?: string | null; expanded?: boolean }
    ) => {
      holdSessionId(sessionId);
      const normalizedOptions =
        typeof options === 'string' || options === null
          ? { parentNodeId: options }
          : options;
      const resolvedParentId =
        normalizedOptions?.parentNodeId !== undefined
          ? normalizedOptions.parentNodeId
          : consumeCanvasParentNodeId();
      const current = documentRef.current.nodes;
      const existing = current.find(
        (node) => isSessionNode(node) && node.sessionId === sessionId
      );
      if (existing) {
        if (normalizedOptions?.expanded && !existing.expanded) {
          updateNodes((items) => openSessionWindow(items, existing.id));
        }
        if (resolvedParentId && resolvedParentId !== existing.id) {
          addLinkToDocument(resolvedParentId, existing.id, 'right', 'left');
        }
        setSelectedIds(new Set([existing.id]));
        focusCanvasNode(existing);
        return existing;
      }
      const wantExpanded = normalizedOptions?.expanded ?? false;
      const size = wantExpanded
        ? { width: DETAIL_CARD_WIDTH, height: DETAIL_CARD_HEIGHT }
        : { width: CARD_WIDTH, height: CARD_HEIGHT };
      const parentNode = resolvedParentId
        ? nodeById(current, resolvedParentId)
        : undefined;
      const drop = nextDropPoint(current);
      const center = canvasFlowCenter();
      const point = parentNode
        ? childPlacementNearParent(current, parentNode, size)
        : current.length === 0
          ? {
              x: center.x - size.width / 2,
              y: center.y - size.height / 2,
            }
          : drop;
      const next: SessionCanvasNode = {
        ...createCanvasNode(sessionId, point, undefined, size),
        expanded: wantExpanded,
      };
      updateNodes((items) => [...items, next]);
      if (resolvedParentId && resolvedParentId !== next.id) {
        addLinkToDocument(resolvedParentId, next.id, 'right', 'left');
      }
      setSelectedIds(new Set([next.id]));
      window.setTimeout(() => {
        const placed = documentRef.current.nodes.find(
          (node) => node.id === next.id
        );
        if (placed) focusCanvasNode(placed);
      }, 40);
      return next;
    },
    [
      addLinkToDocument,
      canvasFlowCenter,
      focusCanvasNode,
      holdSessionId,
      updateNodes,
    ]
  );

  const openOrFocusSessionNode = useCallback(
    (request: OpenCanvasSessionRequest): string => {
      const node = addSession(request.sessionId, {
        parentNodeId: request.parentNodeId,
        expanded: request.expanded,
      });
      return node.id;
    },
    [addSession]
  );

  const openOrFocusPanelNode = useCallback(
    (options: OpenCanvasPanelRequest): string => {
      const resolvedParentId =
        options.parentNodeId !== undefined
          ? options.parentNodeId
          : consumeCanvasParentNodeId();
      const current = documentRef.current.nodes;
      const existing = current.find(
        (node) => isPanelCanvasNode(node) && node.panelId === options.id
      );
      if (existing) {
        updateNodes((items) =>
          items.map((node) =>
            node.id === existing.id
              ? {
                  ...node,
                  panelTitle: options.title ?? node.panelTitle,
                  panelParams: options.params ?? node.panelParams,
                  expanded:
                    options.expanded !== undefined
                      ? options.expanded
                      : node.expanded,
                  width:
                    options.expanded === true && !node.expanded
                      ? DETAIL_CARD_WIDTH
                      : node.width,
                  height:
                    options.expanded === true && !node.expanded
                      ? DETAIL_CARD_HEIGHT
                      : node.height,
                }
              : node
          )
        );
        if (resolvedParentId && resolvedParentId !== existing.id) {
          addLinkToDocument(resolvedParentId, existing.id, 'right', 'left');
        }
        setSelectedIds(new Set([existing.id]));
        focusCanvasNode(existing);
        return existing.id;
      }

      const wantExpanded = options.expanded ?? true;
      const size = wantExpanded
        ? { width: DETAIL_CARD_WIDTH, height: DETAIL_CARD_HEIGHT }
        : { width: CARD_WIDTH, height: CARD_HEIGHT };
      const parentNode = resolvedParentId
        ? nodeById(current, resolvedParentId)
        : undefined;
      const center = canvasFlowCenter();
      const point =
        options.position ??
        (parentNode
          ? childPlacementNearParent(current, parentNode, size)
          : current.length === 0
            ? {
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
              }
            : findEmptyCanvasPlacement(current, size, nextDropPoint(current)));
      const next = createCanvasPanelNode({
        panelId: options.id,
        panelComponent: options.component,
        panelTitle: options.title,
        panelParams: options.params,
        position: point,
        expanded: wantExpanded,
        size,
      });
      updateNodes((items) => [...items, next]);
      if (resolvedParentId && resolvedParentId !== next.id) {
        addLinkToDocument(resolvedParentId, next.id, 'right', 'left');
      }
      setSelectedIds(new Set([next.id]));
      window.setTimeout(() => {
        const placed = documentRef.current.nodes.find(
          (node) => node.id === next.id
        );
        if (placed) focusCanvasNode(placed);
      }, 40);
      return next.id;
    },
    [addLinkToDocument, canvasFlowCenter, focusCanvasNode, updateNodes]
  );

  const updatePanelNodeMeta = useCallback(
    (
      instanceId: string,
      patch: {
        title?: string;
        params?: Record<string, unknown>;
      }
    ) => {
      updateNodes((items) =>
        items.map((node) => {
          if (node.id !== instanceId) return node;
          const nextTitle = patch.title ?? node.panelTitle;
          const nextParams = patch.params
            ? { ...(node.panelParams ?? {}), ...patch.params }
            : node.panelParams;
          if (
            nextTitle === node.panelTitle &&
            nextParams === node.panelParams
          ) {
            return node;
          }
          return {
            ...node,
            panelTitle: nextTitle,
            panelParams: nextParams,
          };
        })
      );
    },
    [updateNodes]
  );

  const dropSessionAt = useCallback(
    (
      sessionId: string,
      client: { x: number; y: number },
      cardWidth?: number | null
    ) => {
      holdSessionId(sessionId);
      const flow = screenToFlowPosition(client);
      const size = collapsedSessionCardSize(cardWidth);
      const next = createCanvasNode(
        sessionId,
        canvasDropOrigin(flow, size),
        undefined,
        size
      );
      updateNodes((items) => [...items, next]);
      setSelectedIds(new Set([next.id]));
    },
    [holdSessionId, screenToFlowPosition, updateNodes]
  );

  const addOrFocus = useCallback(
    (session: KanbanProjectSessionRecord) => {
      const existing = documentRef.current.nodes.find(
        (node) => isSessionNode(node) && node.sessionId === session.id
      );
      if (existing) {
        setSelectedIds(new Set([existing.id]));
        focusCanvasNode(existing);
        return;
      }
      addSession(session.id);
    },
    [addSession, focusCanvasNode]
  );

  // Focus-request reveal: place the session card onto the canvas and focus it.
  // When the card is already on the canvas the node is left untouched — the
  // window focus performed by the caller is the entire reveal.
  const revealSessionOnCanvas = useCallback(
    (sessionId: string) => {
      const existing = documentRef.current.nodes.find(
        (node) => isSessionNode(node) && node.sessionId === sessionId
      );
      if (existing) {
        return;
      }
      addSession(sessionId);
    },
    [addSession]
  );

  const applyCanvasReveal = useCallback(() => {
    if (!sessionsReady) return;
    const request = peekCanvasReveal();
    if (!request || request.projectId !== projectId) return;
    const record = sessionsById.get(request.sessionId);
    if (!record) return;
    // Only the matching canvas clears the request, so a reveal that arrives
    // before this canvas (or its session list) is ready is still honored.
    clearCanvasReveal({ projectId });
    revealSessionOnCanvas(request.sessionId);
  }, [projectId, revealSessionOnCanvas, sessionsById, sessionsReady]);

  const applyCanvasRevealRef = useRef(applyCanvasReveal);
  applyCanvasRevealRef.current = applyCanvasReveal;

  useEffect(
    () =>
      subscribeCanvasReveal(() => {
        applyCanvasRevealRef.current();
      }),
    []
  );

  useEffect(() => {
    // Re-attempt whenever readiness or the session list changes while a reveal
    // request is still pending (e.g. it arrived before data loaded).
    if (sessionsReady) {
      applyCanvasRevealRef.current();
    }
  }, [projectId, sessionsById, sessionsReady]);

  useEffect(() => {
    setHeldSessionIds((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set(current);
      for (const id of current) {
        if (liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [liveIds]);

  useEffect(() => {
    const ids = [
      ...new Set(nodes.filter(isSessionNode).map((node) => node.sessionId)),
    ];
    const key = ids.join('\0');
    if (key === presentIdsKeyRef.current) return;
    presentIdsKeyRef.current = key;
    onPresentIdsChange?.(ids);
  }, [nodes, onPresentIdsChange]);

  useEffect(() => {
    const key = windowSessionIds.join('\0');
    if (key === windowIdsKeyRef.current) return;
    windowIdsKeyRef.current = key;
    onWindowSessionIdsChange?.([...windowSessionIds]);
  }, [onWindowSessionIdsChange, windowSessionIds]);

  const expandCard = useCallback(
    (instanceId: string) => {
      updateNodes((items) => openSessionWindow(items, instanceId));
    },
    [updateNodes]
  );

  const collapseCard = useCallback(
    (instanceId: string) => {
      updateNodes((items) => closeSessionWindow(items, instanceId));
    },
    [updateNodes]
  );

  const removeCard = useCallback(
    (instanceId: string) => {
      updateNodes((items) => removeCanvasNode(items, instanceId));
      setSelectedIds((current) => {
        if (!current.has(instanceId)) return current;
        const next = new Set(current);
        next.delete(instanceId);
        return next;
      });
    },
    [updateNodes]
  );

  const duplicateCanvasNode = useCallback(
    (instanceId: string): string | null => {
      const current = documentRef.current.nodes;
      const source = nodeById(current, instanceId);
      if (!source || isGroupNode(source)) return null;
      const size = sizeForNode(source);
      const point = childPlacementNearParent(current, source, size);
      let copy: SessionCanvasNode;
      if (isPanelCanvasNode(source)) {
        const component = source.panelComponent ?? 'panel';
        const suffix = `${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 5)}`;
        const nextPanelId =
          component === 'terminal'
            ? `terminal-${suffix}`
            : `${source.panelId ?? component}-${suffix}`;
        copy = createCanvasPanelNode({
          panelId: nextPanelId,
          panelComponent: component,
          panelTitle: source.panelTitle ?? component,
          panelParams: source.panelParams ? { ...source.panelParams } : {},
          position: point,
          expanded: source.expanded,
          size,
        });
      } else {
        copy = {
          ...createCanvasNode(source.sessionId, point, undefined, size),
          expanded: source.expanded,
        };
      }
      updateNodes((items) => [...items, copy]);
      addLinkToDocument(source.id, copy.id, 'right', 'left');
      setSelectedIds(new Set([copy.id]));
      window.setTimeout(() => {
        const placed = documentRef.current.nodes.find(
          (node) => node.id === copy.id
        );
        if (placed) focusCanvasNode(placed);
      }, 40);
      return copy.id;
    },
    [addLinkToDocument, focusCanvasNode, updateNodes]
  );

  const closeOtherCanvasNodes = useCallback(
    (keepInstanceId: string) => {
      const current = documentRef.current.nodes;
      const keepNode = nodeById(current, keepInstanceId);
      if (!keepNode) return;
      const keepIds = new Set<string>([keepInstanceId]);
      if (keepNode.parentId) {
        keepIds.add(keepNode.parentId);
      }
      updateNodes((items) => items.filter((node) => keepIds.has(node.id)));
      setSelectedIds(new Set([keepInstanceId]));
    },
    [updateNodes]
  );

  const closeAllCanvasNodes = useCallback(() => {
    updateNodes(() => []);
    setSelectedIds(new Set());
  }, [updateNodes]);

  const sortCanvasNodes = useCallback(
    (by: 'type' | 'name' | 'ActiveTime' = 'name') => {
      updateNodes((items) => {
        const sorted = [...items].sort((a, b) => {
          if (by === 'type') {
            const typeA = isPanelCanvasNode(a)
              ? (a.panelComponent ?? '')
              : isGroupNode(a)
                ? 'group'
                : 'session';
            const typeB = isPanelCanvasNode(b)
              ? (b.panelComponent ?? '')
              : isGroupNode(b)
                ? 'group'
                : 'session';
            return typeA.localeCompare(typeB);
          }
          if (by === 'name') {
            const nameA = isPanelCanvasNode(a)
              ? (a.panelTitle ?? a.panelComponent ?? '')
              : isGroupNode(a)
                ? (a.name ?? '')
                : (sessionsByIdRef.current.get(a.sessionId)?.fullName ??
                  a.sessionId);
            const nameB = isPanelCanvasNode(b)
              ? (b.panelTitle ?? b.panelComponent ?? '')
              : isGroupNode(b)
                ? (b.name ?? '')
                : (sessionsByIdRef.current.get(b.sessionId)?.fullName ??
                  b.sessionId);
            return nameA.localeCompare(nameB);
          }
          const timeA = isSessionNode(a)
            ? new Date(
                sessionsByIdRef.current.get(a.sessionId)?.updatedAt ?? 0
              ).getTime()
            : 0;
          const timeB = isSessionNode(b)
            ? new Date(
                sessionsByIdRef.current.get(b.sessionId)?.updatedAt ?? 0
              ).getTime()
            : 0;
          return timeB - timeA;
        });
        const moves = packLayout(sorted);
        return applyMoves(sorted, moves);
      });
    },
    [updateNodes]
  );

  const removeSession = useCallback(
    (sessionId: string) => {
      const removedIds = documentRef.current.nodes.flatMap((node) =>
        isSessionNode(node) && node.sessionId === sessionId ? [node.id] : []
      );
      if (removedIds.length === 0) return;
      const removed = new Set(removedIds);
      updateNodes((items) => items.filter((node) => !removed.has(node.id)));
      setSelectedIds((current) => {
        let changed = false;
        const next = new Set(current);
        for (const id of removed) {
          changed = next.delete(id) || changed;
        }
        return changed ? next : current;
      });
    },
    [updateNodes]
  );

  useEffect(() => {
    onApiReady?.({
      addOrFocus,
      addSession,
      openOrFocusPanel: openOrFocusPanelNode,
      openOrFocusSession: openOrFocusSessionNode,
      dropSessionAt,
      presentSessionIds,
      removeSession,
    });
  }, [
    addOrFocus,
    addSession,
    dropSessionAt,
    onApiReady,
    openOrFocusPanelNode,
    openOrFocusSessionNode,
    presentSessionIds,
    removeSession,
  ]);

  useEffect(() => {
    return registerCanvasWorkspaceController({
      openOrFocusPanel: (request) => openOrFocusPanelNode(request),
      openOrFocusSession: (request) => openOrFocusSessionNode(request),
      closeNode: (instanceId) => removeCard(instanceId),
      closeOtherNodes: (keepInstanceId) => closeOtherCanvasNodes(keepInstanceId),
      closeAllNodes: () => closeAllCanvasNodes(),
      duplicateNode: (instanceId) => duplicateCanvasNode(instanceId),
    });
  }, [
    closeAllCanvasNodes,
    closeOtherCanvasNodes,
    duplicateCanvasNode,
    openOrFocusPanelNode,
    openOrFocusSessionNode,
    removeCard,
  ]);

  const zoomToCard = useCallback(
    (instanceId: string) => {
      void fitView({
        nodes: [{ id: canvasNodeId(instanceId) }],
        padding: 0.2,
        duration: 280,
        maxZoom: 1.2,
      });
    },
    [fitView]
  );

  const previewResize = useCallback(
    (instanceId: string, geometry: CanvasNodeGeometry) => {
      updateNodes(
        (items) =>
          items.map((node) =>
            node.id === instanceId ? resizeNode(node, geometry) : node
          ),
        false
      );
    },
    [updateNodes]
  );

  const resizeCard = useCallback(
    (instanceId: string, geometry: CanvasNodeGeometry) => {
      updateNodes((items) =>
        items.map((node) =>
          node.id === instanceId ? resizeNode(node, geometry) : node
        )
      );
    },
    [updateNodes]
  );

  const resetCardSize = useCallback(
    (instanceId: string) => {
      updateNodes((items) =>
        items.map((node) =>
          node.id === instanceId ? resetNodeSize(node) : node
        )
      );
    },
    [updateNodes]
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      updateNodes((items) => renameCanvasGroup(items, groupId, name));
    },
    [updateNodes]
  );

  const toggleGroupShowAll = useCallback(
    (groupId: string) => {
      updateNodes((items) => toggleCanvasGroupShowAll(items, groupId));
    },
    [updateNodes]
  );

  const beginGroupResize = useCallback((groupId: string) => {
    const group = nodeById(documentRef.current.nodes, groupId);
    if (!group || !isGroupNode(group)) return;
    groupResizeOriginRef.current = {
      id: groupId,
      width: group.width,
      height: group.height,
    } satisfies GroupResizeOrigin & { id: string };
  }, []);

  const originForGroupResize = useCallback(
    (
      groupId: string,
      geometry?: CanvasNodeGeometry
    ): GroupResizeOrigin | undefined => {
      const stored = groupResizeOriginRef.current;
      const base =
        stored?.id === groupId
          ? stored
          : (() => {
              const group = nodeById(documentRef.current.nodes, groupId);
              if (!group || !isGroupNode(group)) return null;
              const next: GroupResizeOrigin & { id: string } = {
                id: groupId,
                width: group.width,
                height: group.height,
              };
              groupResizeOriginRef.current = next;
              return next;
            })();
      if (!base) return undefined;
      if (!geometry) {
        return { width: base.width, height: base.height, axis: base.axis };
      }
      const axis = inferGroupResizeAxis(base, geometry);
      if (axis && base.axis !== axis) {
        groupResizeOriginRef.current = { ...base, axis };
      }
      return {
        width: base.width,
        height: base.height,
        axis: axis ?? base.axis,
      };
    },
    []
  );

  const previewGroupResize = useCallback(
    (groupId: string, geometry: CanvasNodeGeometry) => {
      const origin = originForGroupResize(groupId, geometry);
      updateNodes(
        (items) => previewGroupFrame(items, groupId, geometry, origin),
        false
      );
    },
    [originForGroupResize, updateNodes]
  );

  const resizeGroup = useCallback(
    (groupId: string, geometry: CanvasNodeGeometry) => {
      const origin = originForGroupResize(groupId, geometry);
      groupResizeOriginRef.current = null;
      updateNodes((items) =>
        resizeGroupFrame(items, groupId, geometry, origin)
      );
    },
    [originForGroupResize, updateNodes]
  );

  const collapseGroup = useCallback(
    (groupId: string) => {
      updateNodes((items) => toggleGroupCollapsed(items, groupId));
    },
    [updateNodes]
  );

  const viewContext = useMemo<SessionCanvasViewContextValue>(
    () => ({
      sessionStore: sessionStoreRef.current,
      sessionsReady,
      expandCard,
      collapseCard,
      removeCard,
      zoomToCard,
      previewResize,
      resizeCard,
      resetCardSize,
      renameGroup,
      toggleGroupShowAll,
      beginGroupResize,
      previewGroupResize,
      resizeGroup,
      collapseGroup,
      onRenameSession,
      onArchiveSession,
      onDeleteSession,
      beginHandleConnect,
      completeHandleConnect,
      hoverHandleTarget,
      isConnectingLink: connectingState != null,
      openOrFocusPanelNode,
      openOrFocusSessionNode,
      duplicateCanvasNode,
      closeOtherCanvasNodes,
      sortCanvasNodes,
      onCreateSessionWithExecutor,
      onNewSession: onCreateSession,
      updatePanelNodeMeta,
    }),
    [
      collapseCard,
      expandCard,
      onArchiveSession,
      onDeleteSession,
      sessionsReady,
      onRenameSession,
      previewResize,
      beginGroupResize,
      previewGroupResize,
      renameGroup,
      resizeGroup,
      collapseGroup,
      toggleGroupShowAll,
      removeCard,
      resetCardSize,
      resizeCard,
      zoomToCard,
      beginHandleConnect,
      completeHandleConnect,
      hoverHandleTarget,
      connectingState,
      openOrFocusPanelNode,
      openOrFocusSessionNode,
      duplicateCanvasNode,
      closeOtherCanvasNodes,
      sortCanvasNodes,
      onCreateSessionWithExecutor,
      onCreateSession,
      updatePanelNodeMeta,
    ]
  );

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const geometryChanges = changes.flatMap((change) =>
      (change.type === 'position' || change.type === 'dimensions') && change.id
        ? [
            {
              id: change.id,
              type: change.type,
              position:
                change.type === 'position' ? change.position : undefined,
              dimensions:
                change.type === 'dimensions' ? change.dimensions : undefined,
              dragging:
                change.type === 'position' ? change.dragging : undefined,
            },
          ]
        : []
    );
    const primary = alignPrimaryRef.current;
    if (primary && !altHeldRef.current) {
      const lead = geometryChanges.find(
        (change) =>
          change.type === 'position' &&
          parseCanvasNodeId(change.id) === primary.id &&
          change.dragging === true
      );
      if (lead?.position) {
        const alignment = computeAlignment(
          {
            id: primary.id,
            x: lead.position.x,
            y: lead.position.y,
            width: primary.width,
            height: primary.height,
          },
          alignCandidatesRef.current,
          ALIGN_TOLERANCE_PX / Math.max(zoomRef.current, 0.01)
        );
        setAlignGuides((current) =>
          alignGuidesEqual(current, alignment.guides)
            ? current
            : alignment.guides
        );
      }
    } else if (primary && altHeldRef.current) {
      setAlignGuides((current) => (current.length === 0 ? current : []));
    }
    const nextOverlay = dragOverlayFromPositionChanges(
      documentRef.current.nodes,
      geometryChanges,
      dragOverlayRef.current
    );
    if (nextOverlay !== dragOverlayRef.current) {
      dragOverlayRef.current = nextOverlay;
      setDragOverlay(nextOverlay);
    }
    setSelectedIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const change of changes) {
        if (change.type !== 'select') continue;
        const instanceId = parseCanvasNodeId(change.id);
        if (!instanceId) continue;
        if (change.selected) {
          if (!next.has(instanceId)) {
            next.add(instanceId);
            changed = true;
          }
        } else if (next.delete(instanceId)) {
          changed = true;
        }
      }
      if (!changed) return current;
      const resolved = marqueeSelectingRef.current
        ? expandSelectionToGroups(documentRef.current.nodes, next)
        : excludeSelectedGroupChildren(documentRef.current.nodes, next);
      if (
        resolved.size === current.size &&
        [...resolved].every((id) => current.has(id))
      ) {
        return current;
      }
      return resolved;
    });
  }, []);

  const handleNodeDragStart = useCallback((_event: unknown, dragged: Node) => {
    const instanceId = parseCanvasNodeId(dragged.id);
    if (!instanceId) return;
    setDraggedId(instanceId);
    const items = documentRef.current.nodes;
    const model = nodeById(items, instanceId);
    const moving = new Set<string>([instanceId]);
    alignCandidatesRef.current = items
      .filter(
        (node) => !moving.has(node.id) && (!node.parentId || node.expanded)
      )
      .map((node) => {
        const origin = flowPositionToWorld(items, node, {
          x: node.x,
          y: node.y,
        });
        const size = sizeForNode(node);
        return {
          id: node.id,
          x: origin.x,
          y: origin.y,
          width: size.width,
          height: size.height,
        };
      });
    alignPrimaryRef.current =
      model && !(model.parentId && !model.expanded)
        ? {
            id: instanceId,
            width: dragged.measured?.width ?? dragged.width ?? CARD_WIDTH,
            height: dragged.measured?.height ?? dragged.height ?? CARD_HEIGHT,
          }
        : null;
    setSelectedIds((current) => {
      if (model && (isGroupNode(model) || model.parentId) && current.size > 0) {
        return new Set([instanceId]);
      }
      if (current.has(instanceId) && current.size > 1) {
        const mixed = [...current].some((id) => {
          const node = nodeById(documentRef.current.nodes, id);
          return Boolean(node && (isGroupNode(node) || node.parentId));
        });
        if (!mixed) return current;
      }
      return new Set([instanceId]);
    });
  }, []);

  const handleNodeDrag = useCallback((_event: unknown, dragged: Node) => {
    const instanceId = parseCanvasNodeId(dragged.id);
    if (!instanceId) return;
    const items = documentRef.current.nodes;
    const model = nodeById(items, instanceId);
    if (!model) return;
    const world = flowPositionToWorld(items, model, dragged.position);
    const hint = visualDropHint(computeDropHint(items, instanceId, world));
    setDropHint((current) => (dropHintsEqual(current, hint) ? current : hint));
  }, []);

  const handleNodeDragStop = useCallback(
    (_event: unknown, dragged: Node) => {
      const instanceId = parseCanvasNodeId(dragged.id);
      const overlay = dragOverlayRef.current;
      const primary = alignPrimaryRef.current;
      let commitSnap = { dx: 0, dy: 0 };
      if (instanceId && primary && !altHeldRef.current) {
        const live = overlay.get(instanceId) ?? {
          x: dragged.position.x,
          y: dragged.position.y,
        };
        const model = nodeById(documentRef.current.nodes, instanceId);
        const size = model ? sizeForNode(model) : { width: 0, height: 0 };
        commitSnap = computeAlignment(
          {
            id: instanceId,
            x: live.x,
            y: live.y,
            width: primary?.width ?? size.width,
            height: primary?.height ?? size.height,
          },
          alignCandidatesRef.current,
          ALIGN_TOLERANCE_PX / Math.max(zoomRef.current, 0.01),
          BOARD_DOT_GAP
        );
      }
      alignPrimaryRef.current = null;
      alignCandidatesRef.current = [];
      setAlignGuides([]);
      setDropHint(null);
      setDraggedId(null);
      setDragOverlay(new Map());
      dragOverlayRef.current = new Map();
      if (!instanceId) return;
      const committed = applyAlignmentDeltaToOverlay(overlay, commitSnap);
      updateNodes((items) => {
        const snapped = applyDragOverlayToCanvasNodes(items, committed);
        const current = nodeById(snapped, instanceId);
        if (!current) return snapped;
        if (current.expanded) return snapped;
        const world = flowPositionToWorld(snapped, current, {
          x: current.x,
          y: current.y,
        });
        return applyDropHint(
          snapped,
          instanceId,
          computeDropHint(snapped, instanceId, world)
        );
      });
    },
    [updateNodes]
  );

  const handleNodeDoubleClick = useCallback(
    (_event: unknown, node: Node) => {
      const instanceId = parseCanvasNodeId(node.id);
      if (!instanceId) return;
      const current = documentRef.current.nodes.find(
        (item) => item.id === instanceId
      );
      if (!current || isGroupNode(current)) return;
      if (current.expanded) return;
      expandCard(instanceId);
    },
    [expandCard]
  );

  const autoArrange = useCallback(() => {
    const moves = packLayout(documentRef.current.nodes);
    updateNodes((items) => applyMoves(items, moves));
    window.setTimeout(() => void fitView({ padding: 0.2, duration: 300 }), 40);
  }, [fitView, updateNodes]);

  const flowOriginAtCanvasCenter = canvasFlowCenter;

  const importSessions = useCallback(
    (sessionIds: string[], groupName: string) => {
      const origin = flowOriginAtCanvasCenter();
      updateNodes((items) => {
        const next = importSessionsAsGroup(
          items,
          sessionIds,
          groupName,
          origin
        );
        return next.length === items.length ? items : next;
      });
      window.setTimeout(
        () => void fitView({ padding: 0.2, duration: 400 }),
        80
      );
    },
    [fitView, flowOriginAtCanvasCenter, updateNodes]
  );

  const createGroupAtView = useCallback(() => {
    const center = flowOriginAtCanvasCenter();
    const footprint = emptyGroupFootprint();
    const preferred = {
      x: center.x - footprint.width / 2,
      y: center.y - footprint.height / 2,
    };
    let createdId: string | null = null;
    let focusX = 0;
    let focusY = 0;
    updateNodes((items) => {
      const origin = findEmptyCanvasPlacement(items, footprint, preferred);
      const next = createEmptyGroup(
        items,
        origin,
        t('settings:kanbanUi.defaultGroupName')
      );
      const created = next.find(
        (node) =>
          isGroupNode(node) && !items.some((item) => item.id === node.id)
      );
      if (created) {
        createdId = created.id;
        const size = sizeForNode(created);
        focusX = created.x + size.width / 2;
        focusY = created.y + size.height / 2;
      }
      return next;
    });
    if (createdId) {
      setSelectedIds(new Set([createdId]));
      window.setTimeout(() => {
        void setCenter(focusX, focusY, {
          duration: 280,
          zoom: currentCanvasZoom(),
        });
      }, 40);
    }
  }, [currentCanvasZoom, flowOriginAtCanvasCenter, setCenter, t, updateNodes]);

  const deleteSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    updateNodes((items) => {
      const ids = collectSelectionForRemoval(items, selectedIds);
      return items.filter((node) => !ids.has(node.id));
    });
    setSelectedIds(new Set());
  }, [selectedIds, updateNodes]);

  const expandSelection = useCallback(() => {
    updateNodes((items) => {
      let next = items;
      for (const id of selectedIds) {
        const node = nodeById(next, id);
        if (!node || isGroupNode(node) || node.expanded) continue;
        next = openSessionWindow(next, id);
      }
      return next;
    });
  }, [selectedIds, updateNodes]);

  const collapseSelection = useCallback(() => {
    updateNodes((items) => {
      let next = items;
      for (const id of selectedIds) {
        next = closeSessionWindow(next, id);
      }
      return next;
    });
  }, [selectedIds, updateNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelection();
      }
      const withMeta = event.metaKey || event.ctrlKey;
      if (withMeta && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undoCanvas();
      }
      if (
        withMeta &&
        (event.key.toLowerCase() === 'y' ||
          (event.key.toLowerCase() === 'z' && event.shiftKey))
      ) {
        event.preventDefault();
        redoCanvas();
      }
      if (event.key === 'Enter' && selectedIds.size === 1) {
        const instanceId = [...selectedIds][0];
        const current = documentRef.current.nodes.find(
          (node) => node.id === instanceId
        );
        if (current?.expanded && instanceId) collapseCard(instanceId);
        else if (instanceId) expandCard(instanceId);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    collapseCard,
    deleteSelection,
    expandCard,
    redoCanvas,
    selectedIds,
    undoCanvas,
  ]);

  const handleMove = useCallback((_event: unknown, viewport: Viewport) => {
    zoomRef.current = viewport.zoom;
    surfaceRef.current?.setAttribute('data-canvas-panning', '');
  }, []);

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      surfaceRef.current?.removeAttribute('data-canvas-panning');
      pendingViewport.current = viewport;
      zoomRef.current = viewport.zoom;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        if (!pendingViewport.current) return;
        const next: SessionCanvasViewport = pendingViewport.current;
        persist({ ...documentRef.current, viewport: next });
      }, VIEWPORT_SAVE_DELAY_MS);
    },
    [persist]
  );

  useEffect(
    () => () => {
      surfaceRef.current?.removeAttribute('data-canvas-panning');
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveCanvasDocument(projectId, {
        ...documentRef.current,
        viewport: pendingViewport.current ?? documentRef.current.viewport,
      });
      flushCanvasDocumentPersist();
    },
    [projectId]
  );

  const empty = nodes.length === 0;
  const selectedNodes = nodes.filter((node) => selectedIds.has(node.id));
  const selectedCards = selectedNodes.filter((node) => !isGroupNode(node));
  const selectedExpanded =
    selectedCards.length > 0 && selectedCards.every((node) => node.expanded);
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  const canGroup = canGroupSelection(nodes, selectedIds);
  const canvasContextMenuItems = useMemo<ProductContextMenuItem[]>(
    () => [
      {
        id: 'group-selection',
        label: t('hubCanvas.groupSelection'),
        disabled: !canGroup,
        onSelect: () => {
          updateNodes((items) =>
            groupSelection(
              items,
              selectedIds,
              t('settings:kanbanUi.defaultGroupName')
            )
          );
        },
      },
      {
        id: 'remove-nodes',
        label: t('hubCanvas.removeNodes'),
        onSelect: () => {
          deleteSelection();
        },
      },
    ],
    [canGroup, deleteSelection, selectedIds, t, updateNodes]
  );

  const connectingPreview = useMemo(() => {
    if (!connectingState) return null;
    const sourceNode = nodeById(liveNodes, connectingState.sourceId);
    if (!sourceNode) return null;
    const start = linkAnchor(
      liveNodes,
      sourceNode,
      connectingState.sourceHandle
    );
    if (
      connectingState.hoveredTarget &&
      connectingState.hoveredTarget.nodeId !== connectingState.sourceId
    ) {
      const targetNode = nodeById(
        liveNodes,
        connectingState.hoveredTarget.nodeId
      );
      if (targetNode) {
        const end = linkAnchor(
          liveNodes,
          targetNode,
          connectingState.hoveredTarget.side
        );
        return { start, end };
      }
    }
    return { start, end: connectingState.currentFlowPoint };
  }, [connectingState, liveNodes]);

  return (
    <SessionCanvasViewProvider value={viewContext}>
      <div
        ref={surfaceRef}
        data-canvas-drop="true"
        className="canvas-surface relative h-full w-full"
      >
        <div className="h-full w-full" data-context-menu-zone="forbidden">
          <ReactFlow
            nodes={rfNodes}
            edges={[]}
            nodeTypes={NODE_TYPES}
            nodesConnectable={false}
            edgesReconnectable={false}
            edgesFocusable={false}
            connectionMode={ConnectionMode.Loose}
            onNodesChange={handleNodesChange}
            onNodeDragStart={handleNodeDragStart}
            onNodeDrag={handleNodeDrag}
            onNodeDragStop={handleNodeDragStop}
            onNodeDoubleClick={handleNodeDoubleClick}
            onSelectionStart={() => {
              marqueeSelectingRef.current = true;
            }}
            onSelectionEnd={() => {
              setSelectedIds((current) =>
                expandSelectionToGroups(documentRef.current.nodes, current)
              );
              window.setTimeout(() => {
                marqueeSelectingRef.current = false;
              }, 0);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
            }}
            onNodeContextMenu={(event) => {
              event.preventDefault();
            }}
            onSelectionContextMenu={(event) => {
              event.preventDefault();
            }}
            onMove={handleMove}
            onMoveEnd={handleMoveEnd}
            onInit={(instance) => {
              zoomRef.current = instance.getZoom();
            }}
            fitView={documentState.viewport == null}
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            defaultViewport={documentState.viewport ?? undefined}
            minZoom={CANVAS_MIN_ZOOM}
            maxZoom={CANVAS_MAX_ZOOM}
            elevateNodesOnSelect={false}
            onlyRenderVisibleElements={!canvasHasLiveSurfaces(nodes)}
            panOnDrag={[]}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnScroll
            selectionKeyCode={null}
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={BOARD_DOT_GAP}
              size={1.5}
              className="canvas-dots"
            />
            {alignGuides.length > 0 ? (
              <ViewportPortal>
                {alignGuides.map((guide) => {
                  const hair = 1 / Math.max(zoomRef.current, 0.01);
                  return (
                    <div
                      key={`${guide.axis}-${guide.at}-${guide.from}`}
                      className="pointer-events-none absolute bg-primary/70"
                      style={
                        guide.axis === 'x'
                          ? {
                              transform: `translate(${guide.at}px, ${guide.from}px)`,
                              width: hair,
                              height: guide.to - guide.from,
                            }
                          : {
                              transform: `translate(${guide.from}px, ${guide.at}px)`,
                              width: guide.to - guide.from,
                              height: hair,
                            }
                      }
                    />
                  );
                })}
              </ViewportPortal>
            ) : null}
            {sessionLinks.length > 0 || connectingPreview ? (
              <ViewportPortal>
                <svg
                  className="pointer-events-none absolute overflow-visible"
                  width={1}
                  height={1}
                >
                  {sessionLinks.map((link) => {
                    const from = nodeById(liveNodes, link.sourceId);
                    const to = nodeById(liveNodes, link.targetId);
                    if (!from || !to) return null;
                    const start = linkAnchor(
                      liveNodes,
                      from,
                      link.sourceHandle
                    );
                    const end = linkAnchor(liveNodes, to, link.targetHandle);
                    return (
                      <g key={link.id}>
                        <line
                          className="canvas-session-link"
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          strokeDasharray="6 4"
                          strokeWidth={hoveredLinkId === link.id ? 2.4 : 1.75}
                        />
                        <line
                          data-testid={`canvas-link-hit-${link.id}`}
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          stroke="transparent"
                          strokeWidth={16}
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onMouseEnter={() => setHoveredLinkId(link.id)}
                          onMouseLeave={() =>
                            setHoveredLinkId((prev) =>
                              prev === link.id ? null : prev
                            )
                          }
                        />
                      </g>
                    );
                  })}
                  {connectingPreview ? (
                    <line
                      data-testid="canvas-link-preview"
                      className="canvas-session-link"
                      x1={connectingPreview.start.x}
                      y1={connectingPreview.start.y}
                      x2={connectingPreview.end.x}
                      y2={connectingPreview.end.y}
                      strokeDasharray="4 4"
                      strokeWidth={2}
                    />
                  ) : null}
                </svg>
                {sessionLinks.map((link) => {
                  const from = nodeById(liveNodes, link.sourceId);
                  const to = nodeById(liveNodes, link.targetId);
                  if (!from || !to) return null;
                  const start = linkAnchor(
                    liveNodes,
                    from,
                    link.sourceHandle
                  );
                  const end = linkAnchor(liveNodes, to, link.targetHandle);
                  const midX = (start.x + end.x) / 2;
                  const midY = (start.y + end.y) / 2;
                  const isHovered = hoveredLinkId === link.id;
                  return (
                    <button
                      key={`disconnect-${link.id}`}
                      type="button"
                      data-testid={`canvas-link-disconnect-${link.id}`}
                      aria-label="断开连接"
                      title="断开连接"
                      onMouseEnter={() => setHoveredLinkId(link.id)}
                      onMouseLeave={() =>
                        setHoveredLinkId((prev) =>
                          prev === link.id ? null : prev
                        )
                      }
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        disconnectLink(link);
                      }}
                      className={cn(
                        'nodrag nopan pointer-events-auto absolute z-30 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-opacity hover:border-destructive/60 hover:bg-destructive hover:text-destructive-foreground',
                        isHovered
                          ? 'opacity-100'
                          : 'opacity-0 hover:opacity-100 focus:opacity-100'
                      )}
                      style={{
                        left: midX,
                        top: midY,
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  );
                })}
              </ViewportPortal>
            ) : null}
            {dropHint?.type === 'merge' ? (
              <ViewportPortal>
                <div
                  className="canvas-board-units pointer-events-none absolute flex items-start justify-center rounded-xl border-2 border-dashed border-primary/70 bg-primary/5"
                  style={{
                    transform: `translate(${dropHint.rect.x}px, ${dropHint.rect.y}px)`,
                    width: dropHint.rect.width,
                    height: dropHint.rect.height,
                  }}
                >
                  <span className="mt-1 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                    {t('hubCanvas.mergeIntoGroup')}
                  </span>
                </div>
              </ViewportPortal>
            ) : null}
            <Panel position="bottom-center" data-canvas-export-skip="">
              <div
                className="flex items-center gap-2"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <SessionCanvasHistoryDock
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onUndo={undoCanvas}
                  onRedo={redoCanvas}
                />
                <SessionCanvasDock
                  selectedCount={selectedIds.size}
                  selectedExpanded={selectedExpanded}
                  selectedGroupCollapsed={
                    selectedNodes.length === 1 &&
                    isGroupNode(selectedNodes[0]) &&
                    selectedNodes[0].collapsed === true
                  }
                  selectedIsGroup={
                    selectedNodes.length === 1 && isGroupNode(selectedNodes[0])
                  }
                  onToggleGroupCollapse={() => {
                    const group = selectedNodes.find(isGroupNode);
                    if (group) collapseGroup(group.id);
                  }}
                  onCreateGroup={createGroupAtView}
                  onCreateSession={() => onCreateSession?.()}
                  onCreateSessionWithExecutor={onCreateSessionWithExecutor}
                  onCreatePanelNode={(options) => {
                    openOrFocusPanelNode(options);
                  }}
                  onImportByProject={() => setImportMode('project')}
                  onImportByRecent={() => setImportMode('recent')}
                  onImportByAgent={() => setImportMode('agent')}
                  onFitView={() =>
                    void fitView({ padding: 0.2, duration: 300 })
                  }
                  onAutoArrange={autoArrange}
                  onExpandSelection={expandSelection}
                  onCollapseSelection={collapseSelection}
                  onDeleteSelection={deleteSelection}
                />
              </div>
            </Panel>
            <SessionCanvasViewportPanel
              mapVisible={documentState.minimapVisible}
              onMapVisibleChange={(visible) =>
                persist({ ...documentRef.current, minimapVisible: visible })
              }
            />
          </ReactFlow>
        </div>

        {!hideSessionList ? (
          <FloatingSessionList collapsed={!listVisible} width={listWidth}>
            {list}
          </FloatingSessionList>
        ) : null}
        {createPanel ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-20 flex items-center"
            style={{
              left:
                !hideSessionList && listVisible
                  ? `calc(0.75rem + ${listWidth}px + 0.75rem)`
                  : '0.75rem',
            }}
          >
            <div className="pointer-events-auto">{createPanel}</div>
          </div>
        ) : null}

        {empty ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <MapIcon
              className="size-10 text-muted-foreground/40"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t('hubCanvas.empty')}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t('hubCanvas.emptyHint')}
              </p>
            </div>
            <button
              type="button"
              className={cn(
                'pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90'
              )}
              onClick={() => setImportMode('recent')}
            >
              <Wand2 className="size-3.5" />
              {t('hubCanvas.importRecent')}
            </button>
          </div>
        ) : null}

        <ImportRecentSessionsDialog
          open={importMode != null}
          mode={importMode ?? 'recent'}
          projectName={projectName}
          sessions={sessions}
          presentSessionIds={presentSessionIds()}
          onOpenChange={(open) => {
            if (!open) setImportMode(null);
          }}
          onImport={importSessions}
        />
        {selectionMenu ? (
          <ProductContextMenu
            x={selectionMenu.x}
            y={selectionMenu.y}
            items={canvasContextMenuItems}
            onClose={() => setSelectionMenu(null)}
          />
        ) : null}
      </div>
    </SessionCanvasViewProvider>
  );
}

export function SessionCanvasView(props: SessionCanvasViewProps) {
  return (
    <ReactFlowProvider>
      <SessionCanvasFlow {...props} />
    </ReactFlowProvider>
  );
}
