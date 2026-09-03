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
import { Map as MapIcon, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
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
import { cn } from '@/lib/utils';
import { FloatingSessionList } from './FloatingSessionList';
import { ImportRecentSessionsDialog } from './ImportRecentSessionsDialog';
import { SessionCanvasCardNode } from './SessionCanvasCardNode';
import { SessionCanvasDetailNode } from './SessionCanvasDetailNode';
import { SessionCanvasDock } from './SessionCanvasDock';
import { SessionCanvasGroupNode } from './SessionCanvasGroupNode';
import {
  applyFlowGeometryChanges,
  applyDropHint,
  buildCanvasFlowLookups,
  computeDropHint,
  canGroupSelection,
  collectSelectionForRemoval,
  excludeSelectedGroupChildren,
  expandSelectionToGroups,
  emptyGroupFootprint,
  findEmptyCanvasPlacement,
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
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CARD_HEIGHT,
  CARD_WIDTH,
  DRAG_HANDLE_SELECTOR,
  alignGuidesEqual,
  applyMoves,
  canvasNodeId,
  computeAlignment,
  createCanvasNode,
  nextDropPoint,
  packLayout,
  parseCanvasNodeId,
  canvasWindowSlotIndex,
  displayedCanvasNodes,
  openWindowSessionIds,
  preferLiveKanbanSessions,
  removeCanvasNode,
  resetNodeSize,
  resizeNode,
  reuseUnchangedFlowNode,
  sameSessionLinks,
  sizeForNode,
  type AlignmentGuide,
  type CanvasNodeGeometry,
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
  addSession: (sessionId: string) => void;
  dropSessionAt: (sessionId: string, client: { x: number; y: number }) => void;
  presentSessionIds: () => Set<string>;
}

interface SessionCanvasViewProps {
  projectId: string;
  sessions: KanbanProjectSessionRecord[];
  sessionsReady?: boolean;
  listWidth: number;
  list: ReactNode;
  createPanel?: ReactNode;
  projectName?: string;
  onRenameSession?: (
    session: KanbanProjectSessionRecord,
    name: string | null
  ) => Promise<void>;
  onDeleteSession?: (
    session: KanbanProjectSessionRecord
  ) => void | Promise<void>;
  onApiReady?: (api: SessionCanvasApi) => void;
  onPresentIdsChange?: (sessionIds: string[]) => void;
  onWindowSessionIdsChange?: (sessionIds: string[]) => void;
  onCreateSession?: () => void;
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
      width: size.width,
      height: size.height,
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
  const slotIndex = canvasWindowSlotIndex(node.sessionId, windowSessionIds);
  return {
    id: canvasNodeId(node.id),
    type: node.expanded ? 'sessionDetail' : 'sessionCard',
    position,
    width: size.width,
    height: size.height,
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
      isRunning: runningSessionIds.has(node.sessionId),
    },
  };
}

function linkAnchor(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode
): { x: number; y: number } {
  const rect = worldRect(nodes, node);
  if (node.expanded) {
    return { x: rect.x + rect.width / 2, y: rect.y + CARD_HEIGHT / 2 };
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function SessionCanvasFlow({
  projectId,
  sessions,
  sessionsReady = true,
  listWidth,
  list,
  createPanel = null,
  projectName = '',
  onRenameSession,
  onDeleteSession,
  onApiReady,
  onPresentIdsChange,
  onWindowSessionIdsChange,
  onCreateSession,
}: SessionCanvasViewProps) {
  const { t } = useTranslation(['tasks']);
  const queryClient = useQueryClient();
  const listVisible = useKanbanCanvasListVisible();
  const { fitView, setCenter, screenToFlowPosition } = useReactFlow();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onMiddleClickRef = useRef<(event: MouseEvent) => void>(() => {});
  const onMiddleClick = useCallback((event: MouseEvent) => {
    onMiddleClickRef.current(event);
  }, []);
  useCanvasRightDragPan(surfaceRef, onMiddleClick);
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
  const [alignGuides, setAlignGuides] = useState<AlignmentGuide[]>([]);
  const [, setHistoryVersion] = useState(0);
  const historyRef = useRef<{
    past: SessionCanvasNode[][];
    future: SessionCanvasNode[][];
  }>({ past: [], future: [] });
  const skipHistoryRef = useRef(false);
  const marqueeSelectingRef = useRef(false);
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!selectionMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const menu = selectionMenuRef.current;
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      setSelectionMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [selectionMenu]);
  const alignmentDeltaRef = useRef({ dx: 0, dy: 0 });
  const flowNodeCacheRef = useRef(new Map<string, Node>());
  const zoomRef = useRef(documentState.viewport?.zoom ?? 1);
  const pendingViewport = useRef<Viewport | null>(documentState.viewport);
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
  const liveIds = useMemo(
    () => new Set(displaySessions.map((session) => session.id)),
    [displaySessions]
  );
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
    () => displayedCanvasNodes(documentState.nodes, liveIds, sessionsReady),
    [documentState.nodes, liveIds, sessionsReady]
  );
  const windowSessionIds = useMemo(() => openWindowSessionIds(nodes), [nodes]);
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessionsById.values()) {
      if (sessionAttentionKind(session) === 'running') ids.add(session.id);
    }
    return ids;
  }, [sessionsById]);
  const reviewSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessionsById.values()) {
      if (sessionAttentionKind(session) === 'review') ids.add(session.id);
    }
    return ids;
  }, [sessionsById]);
  sessionStoreRef.current.replace(sessionsById, sessionsReady);

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

  const rfNodes = useMemo(() => {
    const cache = flowNodeCacheRef.current;
    const nextCache = new Map<string, Node>();
    const layoutNodes = previewCanvasDrop(nodes, draggedId, dropHint);
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
      const reused = reuseUnchangedFlowNode(cache.get(built.id), built);
      nextCache.set(reused.id, reused);
      return reused;
    });
    flowNodeCacheRef.current = nextCache;
    return result;
  }, [
    draggedId,
    dropHint,
    nodes,
    reviewSessionIds,
    runningSessionIds,
    selectedIds,
    windowSessionIds,
  ]);

  const sessionLinks = useMemo(
    () =>
      sameSessionLinks(nodes.filter((node) => !isOverflowHidden(nodes, node))),
    [nodes]
  );

  const presentSessionIds = useCallback(
    () => new Set(documentRef.current.nodes.map((node) => node.sessionId)),
    []
  );

  const addSession = useCallback(
    (sessionId: string) => {
      const current = documentRef.current.nodes;
      const existing = current.find((node) => node.sessionId === sessionId);
      if (existing) {
        setSelectedIds(new Set([existing.id]));
        return;
      }
      const drop = nextDropPoint(current);
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const point = current.length === 0 ? { x: center.x, y: center.y } : drop;
      const next = createCanvasNode(sessionId, point);
      updateNodes((items) => [...items, next]);
      setSelectedIds(new Set([next.id]));
    },
    [screenToFlowPosition, updateNodes]
  );

  const dropSessionAt = useCallback(
    (sessionId: string, client: { x: number; y: number }) => {
      const flow = screenToFlowPosition(client);
      const next = createCanvasNode(sessionId, {
        x: flow.x - CARD_WIDTH / 2,
        y: flow.y - CARD_HEIGHT / 2,
      });
      updateNodes((items) => [...items, next]);
      setSelectedIds(new Set([next.id]));
    },
    [screenToFlowPosition, updateNodes]
  );

  const addOrFocus = useCallback(
    (session: KanbanProjectSessionRecord) => {
      const existing = documentRef.current.nodes.find(
        (node) => node.sessionId === session.id
      );
      if (existing) {
        setSelectedIds(new Set([existing.id]));
        const size = sizeForNode(existing);
        void setCenter(
          existing.x + size.width / 2,
          existing.y + size.height / 2,
          { duration: 280, zoom: Math.max(zoomRef.current, 0.8) }
        );
        return;
      }
      addSession(session.id);
    },
    [addSession, setCenter]
  );

  // Focus-request reveal: place the session card onto the canvas and focus it.
  // When the card is already on the canvas the node is left untouched — the
  // window focus performed by the caller is the entire reveal.
  const revealSessionOnCanvas = useCallback(
    (sessionId: string) => {
      const existing = documentRef.current.nodes.find(
        (node) => node.sessionId === sessionId
      );
      if (existing) {
        return;
      }
      addSession(sessionId);
      const added = documentRef.current.nodes.find(
        (node) => node.sessionId === sessionId
      );
      if (added) {
        const size = sizeForNode(added);
        void setCenter(added.x + size.width / 2, added.y + size.height / 2, {
          duration: 280,
          zoom: Math.max(zoomRef.current, 0.8),
        });
      }
    },
    [addSession, setCenter]
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
    onApiReady?.({ addOrFocus, addSession, dropSessionAt, presentSessionIds });
  }, [addOrFocus, addSession, dropSessionAt, onApiReady, presentSessionIds]);

  useEffect(() => {
    onPresentIdsChange?.([...new Set(nodes.map((node) => node.sessionId))]);
  }, [nodes, onPresentIdsChange]);

  useEffect(() => {
    onWindowSessionIdsChange?.(windowSessionIds);
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
    };
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
              const next = {
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
      onDeleteSession,
    }),
    [
      collapseCard,
      expandCard,
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
    ]
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyFlowGeometryChanges(
        documentRef.current.nodes,
        changes.flatMap((change) =>
          (change.type === 'position' || change.type === 'dimensions') &&
          change.id
            ? [
                {
                  id: change.id,
                  type: change.type,
                  position:
                    change.type === 'position' ? change.position : undefined,
                  dimensions:
                    change.type === 'dimensions'
                      ? change.dimensions
                      : undefined,
                  dragging:
                    change.type === 'position' ? change.dragging : undefined,
                },
              ]
            : []
        )
      );
      if (nextNodes !== documentRef.current.nodes) {
        writeDocument({ ...documentRef.current, nodes: nextNodes }, false);
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
    },
    [writeDocument]
  );

  const handleNodeDragStart = useCallback((_event: unknown, dragged: Node) => {
    const instanceId = parseCanvasNodeId(dragged.id);
    if (!instanceId) return;
    setDraggedId(instanceId);
    const model = nodeById(documentRef.current.nodes, instanceId);
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
    const parent = model.parentId && !model.expanded;
    if (parent) {
      alignmentDeltaRef.current = { dx: 0, dy: 0 };
      setAlignGuides((current) => (current.length === 0 ? current : []));
    } else {
      const moving = {
        id: instanceId,
        x: world.x,
        y: world.y,
        width: dragged.measured?.width ?? dragged.width ?? CARD_WIDTH,
        height: dragged.measured?.height ?? dragged.height ?? CARD_HEIGHT,
      };
      const others = items
        .filter(
          (node) => node.id !== instanceId && (!node.parentId || node.expanded)
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
      const alignment = computeAlignment(
        moving,
        others,
        ALIGN_TOLERANCE_PX / Math.max(zoomRef.current, 0.01),
        BOARD_DOT_GAP
      );
      alignmentDeltaRef.current = { dx: alignment.dx, dy: alignment.dy };
      setAlignGuides((current) =>
        alignGuidesEqual(current, alignment.guides) ? current : alignment.guides
      );
    }
    const hint = visualDropHint(computeDropHint(items, instanceId, world));
    setDropHint((current) => (dropHintsEqual(current, hint) ? current : hint));
  }, []);

  const handleNodeDragStop = useCallback(
    (_event: unknown, dragged: Node) => {
      const instanceId = parseCanvasNodeId(dragged.id);
      const { dx, dy } = alignmentDeltaRef.current;
      alignmentDeltaRef.current = { dx: 0, dy: 0 };
      setAlignGuides([]);
      setDropHint(null);
      setDraggedId(null);
      if (!instanceId) return;
      updateNodes((items) => {
        const current = nodeById(items, instanceId);
        if (!current) return items;
        if ((isGroupNode(current) && !current.parentId) || current.expanded) {
          return items.map((node) =>
            node.id === instanceId
              ? {
                  ...node,
                  x: dragged.position.x + dx,
                  y: dragged.position.y + dy,
                }
              : node
          );
        }
        const world = flowPositionToWorld(items, current, {
          x: dragged.position.x + dx,
          y: dragged.position.y + dy,
        });
        const next = items.map((node) =>
          node.id === instanceId
            ? {
                ...node,
                x: dragged.position.x + dx,
                y: dragged.position.y + dy,
              }
            : node
        );
        return applyDropHint(
          next,
          instanceId,
          computeDropHint(next, instanceId, world)
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

  const flowOriginAtCanvasCenter = useCallback(() => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return screenToFlowPosition(
      rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    );
  }, [screenToFlowPosition]);

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
    updateNodes((items) => {
      const origin = findEmptyCanvasPlacement(items, footprint, preferred);
      const next = createEmptyGroup(items, origin);
      createdId =
        next.find(
          (node) =>
            isGroupNode(node) && !items.some((item) => item.id === node.id)
        )?.id ?? null;
      return next;
    });
    if (createdId) {
      setSelectedIds(new Set([createdId]));
      window.setTimeout(() => {
        void fitView({
          nodes: [{ id: canvasNodeId(createdId!) }],
          padding: 0.35,
          duration: 280,
        });
      }, 40);
    }
  }, [fitView, flowOriginAtCanvasCenter, updateNodes]);

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
  }, []);

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
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
  const selectedSessions = selectedNodes.filter(isSessionNode);
  const selectedExpanded =
    selectedSessions.length > 0 &&
    selectedSessions.every((node) => node.expanded);
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  const canGroup = canGroupSelection(nodes, selectedIds);

  return (
    <SessionCanvasViewProvider value={viewContext}>
      <div
        ref={surfaceRef}
        className="canvas-surface relative h-full w-full"
        onContextMenu={(event) => {
          event.preventDefault();
        }}
      >
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
          fitView={documentState.viewport == null}
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          defaultViewport={documentState.viewport ?? undefined}
          minZoom={CANVAS_MIN_ZOOM}
          maxZoom={CANVAS_MAX_ZOOM}
          elevateNodesOnSelect={false}
          panOnDrag={[2]}
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
          {sessionLinks.length > 0 ? (
            <ViewportPortal>
              <svg
                className="pointer-events-none absolute overflow-visible"
                width={1}
                height={1}
              >
                {sessionLinks.map((link) => {
                  const from = nodeById(nodes, link.sourceId);
                  const to = nodeById(nodes, link.targetId);
                  if (!from || !to) return null;
                  const start = linkAnchor(nodes, from);
                  const end = linkAnchor(nodes, to);
                  return (
                    <line
                      key={link.id}
                      className="canvas-session-link"
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                      strokeDasharray="6 4"
                      strokeWidth={1.75}
                    />
                  );
                })}
              </svg>
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
                <span className="mt-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
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
                onImportByProject={() => setImportMode('project')}
                onImportByRecent={() => setImportMode('recent')}
                onImportByAgent={() => setImportMode('agent')}
                onFitView={() => void fitView({ padding: 0.2, duration: 300 })}
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

        <FloatingSessionList collapsed={!listVisible} width={listWidth}>
          {list}
        </FloatingSessionList>
        {listVisible && createPanel ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-20 flex items-center"
            style={{ left: `calc(0.75rem + ${listWidth}px + 0.75rem)` }}
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
        {selectionMenu
          ? createPortal(
              <div
                ref={selectionMenuRef}
                role="menu"
                className="tahoe-popover fixed z-[100000] min-w-36 rounded-md p-1 text-popover-foreground"
                style={{ left: selectionMenu.x, top: selectionMenu.y }}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canGroup}
                  className="flex w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-control-hover)] disabled:pointer-events-none disabled:opacity-40"
                  onClick={() => {
                    updateNodes((items) => groupSelection(items, selectedIds));
                    setSelectionMenu(null);
                  }}
                >
                  {t('hubCanvas.groupSelection')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-control-hover)]"
                  onClick={() => {
                    deleteSelection();
                    setSelectionMenu(null);
                  }}
                >
                  {t('hubCanvas.removeNodes')}
                </button>
              </div>,
              document.body
            )
          : null}
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
