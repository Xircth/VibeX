import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import { Map as MapIcon, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { useKanbanCanvasListVisible } from '@/lib/kanbanCanvasListVisible';
import { cn } from '@/lib/utils';
import { FloatingSessionList } from './FloatingSessionList';
import { ImportRecentSessionsDialog } from './ImportRecentSessionsDialog';
import { SessionCanvasCardNode } from './SessionCanvasCardNode';
import { SessionCanvasDetailNode } from './SessionCanvasDetailNode';
import { SessionCanvasDock } from './SessionCanvasDock';
import { SessionCanvasGroupNode } from './SessionCanvasGroupNode';
import {
  applyDescendantDelta,
  applyFlowGeometryChanges,
  applyDropHint,
  computeDropHint,
  expandSelectionToGroups,
  groupGridSize,
  groupNumber,
  groupSelection,
  groupSessionCount,
  importSessionsAsGroup,
  isGroupNode,
  isOverflowHidden,
  isSessionNode,
  nodeById,
  placeDetachedWindow,
  dissolveGroup as dissolveCanvasGroup,
  createEmptyGroup,
  renameGroup as renameCanvasGroup,
  toggleGroupShowAll as toggleCanvasGroupShowAll,
  GROUP_VISIBLE_LIMIT,
  resizeGroupFrame,
  toggleGroupCollapsed,
  worldPosition,
  type CanvasDropHint,
} from './canvasGrouping';
import { SessionCanvasViewportPanel } from './SessionCanvasViewportPanel';
import {
  BOARD_DOT_GAP,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CARD_HEIGHT,
  CARD_WIDTH,
  DRAG_HANDLE_SELECTOR,
  applyMoves,
  canvasNodeId,
  collapseNode,
  computeAlignment,
  createCanvasNode,
  expandNode,
  nextDropPoint,
  packLayout,
  parseCanvasNodeId,
  pruneMissingSessions,
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
  loadCanvasDocument,
  saveCanvasDocument,
  type SessionCanvasDocument,
  type SessionCanvasViewport,
} from './canvasStorage';
import {
  SessionCanvasViewProvider,
  type SessionCanvasViewContextValue,
} from './CanvasViewContext';
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
}

function toFlowNode(
  node: SessionCanvasNode,
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>,
  dropHint: CanvasDropHint | null
): Node {
  const size = sizeForNode(node);
  const parent =
    node.parentId && !node.expanded
      ? nodes.find((item) => item.id === node.parentId)
      : undefined;
  const position = { x: node.x, y: node.y };
  const isDropTarget =
    dropHint?.type === 'group' && dropHint.groupId === node.id;
  if (isGroupNode(node)) {
    const count = groupSessionCount(nodes, node.id);
    return {
      id: canvasNodeId(node.id),
      type: 'sessionGroup',
      position,
      width: size.width,
      height: size.height,
      selected: selectedIds.has(node.id),
      parentId: parent ? canvasNodeId(parent.id) : undefined,
      dragHandle: DRAG_HANDLE_SELECTOR,
      className: isDropTarget ? 'canvas-drop-target' : undefined,
      zIndex: isDropTarget ? 3 : 0,
      data: {
        instanceId: node.id,
        name: node.name,
        index: groupNumber(nodes, node.id),
        count,
        overflow: Math.max(0, count - GROUP_VISIBLE_LIMIT),
        showAll: node.showAll,
        collapsed: node.collapsed === true,
      },
    };
  }
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
    zIndex: node.expanded ? 4 : isDropTarget ? 3 : 2,
    data: { sessionId: node.sessionId, instanceId: node.id },
  };
}

const SAME_SESSION_EDGE_OPTIONS = {
  type: 'straight' as const,
  selectable: false,
  focusable: false,
  interactionWidth: 0,
  className: 'canvas-session-link',
  style: {
    stroke: 'color-mix(in oklab, var(--text-muted) 72%, transparent)',
    strokeDasharray: '6 4',
    strokeWidth: 1.75,
  },
};

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
}: SessionCanvasViewProps) {
  const { t } = useTranslation(['tasks']);
  const listVisible = useKanbanCanvasListVisible();
  const { fitView, setCenter, screenToFlowPosition } = useReactFlow();
  const surfaceRef = useRef<HTMLDivElement>(null);
  useCanvasRightDragPan(surfaceRef);
  useCanvasMarqueeTextGuard(surfaceRef);

  const [documentState, setDocumentState] = useState<SessionCanvasDocument>(
    () => loadCanvasDocument(projectId)
  );

  useEffect(() => {
    setDocumentState(loadCanvasDocument(projectId));
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
  const [dropHint, setDropHint] = useState<CanvasDropHint | null>(null);
  const [alignGuides, setAlignGuides] = useState<AlignmentGuide[]>([]);
  const alignmentDeltaRef = useRef({ dx: 0, dy: 0 });
  const flowNodeCacheRef = useRef(new Map<string, Node>());
  const zoomRef = useRef(documentState.viewport?.zoom ?? 1);
  const pendingViewport = useRef<Viewport | null>(documentState.viewport);
  const saveTimer = useRef<number | null>(null);
  const documentRef = useRef(documentState);
  documentRef.current = documentState;

  const liveIds = useMemo(
    () => new Set(sessions.map((session) => session.id)),
    [sessions]
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions]
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
      sessionsReady
        ? pruneMissingSessions(documentState.nodes, liveIds)
        : documentState.nodes,
    [documentState.nodes, liveIds, sessionsReady]
  );

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
      writeDocument(
        { ...current, nodes: mutate(current.nodes) },
        persistToDisk
      );
    },
    [writeDocument]
  );

  const rfNodes = useMemo(() => {
    const cache = flowNodeCacheRef.current;
    const nextCache = new Map<string, Node>();
    const result = nodes.map((node) => {
      const built = toFlowNode(node, nodes, selectedIds, dropHint);
      const reused = reuseUnchangedFlowNode(cache.get(built.id), built);
      nextCache.set(reused.id, reused);
      return reused;
    });
    flowNodeCacheRef.current = nextCache;
    return result;
  }, [dropHint, nodes, selectedIds]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      sameSessionLinks(
        nodes.filter((node) => !isOverflowHidden(nodes, node))
      ).map((link) => ({
        ...link,
        ...SAME_SESSION_EDGE_OPTIONS,
      })),
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

  useEffect(() => {
    onApiReady?.({ addOrFocus, addSession, dropSessionAt, presentSessionIds });
  }, [addOrFocus, addSession, dropSessionAt, onApiReady, presentSessionIds]);

  useEffect(() => {
    onPresentIdsChange?.([...new Set(nodes.map((node) => node.sessionId))]);
  }, [nodes, onPresentIdsChange]);

  const expandCard = useCallback(
    (instanceId: string) => {
      updateNodes((items) =>
        items.map((node) => (node.id === instanceId ? expandNode(node) : node))
      );
    },
    [updateNodes]
  );

  const collapseCard = useCallback(
    (instanceId: string) => {
      updateNodes((items) =>
        items.map((node) =>
          node.id === instanceId ? collapseNode(node) : node
        )
      );
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

  const previewGroupResize = useCallback(
    (groupId: string, geometry: CanvasNodeGeometry) => {
      updateNodes((items) => resizeGroupFrame(items, groupId, geometry), false);
    },
    [updateNodes]
  );

  const resizeGroup = useCallback(
    (groupId: string, geometry: CanvasNodeGeometry) => {
      updateNodes((items) => resizeGroupFrame(items, groupId, geometry));
    },
    [updateNodes]
  );

  const collapseGroup = useCallback(
    (groupId: string) => {
      updateNodes((items) => toggleGroupCollapsed(items, groupId));
    },
    [updateNodes]
  );

  const viewContext = useMemo<SessionCanvasViewContextValue>(
    () => ({
      sessionsById,
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
      previewGroupResize,
      renameGroup,
      resizeGroup,
      collapseGroup,
      toggleGroupShowAll,
      removeCard,
      resetCardSize,
      resizeCard,
      sessionsById,
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
        return changed ? next : current;
      });
    },
    [writeDocument]
  );

  const handleNodeDragStart = useCallback((_event: unknown, dragged: Node) => {
    const instanceId = parseCanvasNodeId(dragged.id);
    if (!instanceId) return;
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
    const parent =
      model.parentId && !model.expanded
        ? nodeById(items, model.parentId)
        : undefined;
    const world = parent
      ? {
          x: worldPosition(items, parent).x + dragged.position.x,
          y: worldPosition(items, parent).y + dragged.position.y,
        }
      : { x: dragged.position.x, y: dragged.position.y };
    if (parent) {
      alignmentDeltaRef.current = { dx: 0, dy: 0 };
      setAlignGuides([]);
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
          const position = worldPosition(items, node);
          const size = sizeForNode(node);
          return {
            id: node.id,
            x: position.x,
            y: position.y,
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
      setAlignGuides(alignment.guides);
    }
    setDropHint(computeDropHint(items, instanceId, world));
  }, []);

  const handleNodeDragStop = useCallback(
    (_event: unknown, dragged: Node) => {
      const instanceId = parseCanvasNodeId(dragged.id);
      const { dx, dy } = alignmentDeltaRef.current;
      alignmentDeltaRef.current = { dx: 0, dy: 0 };
      setAlignGuides([]);
      setDropHint(null);
      if (!instanceId) return;
      updateNodes((items) => {
        const current = nodeById(items, instanceId);
        if (!current) return items;
        if (isGroupNode(current)) {
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
        const parent =
          current.parentId && !current.expanded
            ? nodeById(items, current.parentId)
            : undefined;
        const world = {
          x:
            (parent ? worldPosition(items, parent).x : 0) +
            dragged.position.x +
            dx,
          y:
            (parent ? worldPosition(items, parent).y : 0) +
            dragged.position.y +
            dy,
        };
        return applyDropHint(
          items,
          instanceId,
          computeDropHint(items, instanceId, world)
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
      if (current.parentId && !current.expanded) {
        updateNodes((items) => placeDetachedWindow(items, instanceId));
        return;
      }
      if (current.expanded) return;
      expandCard(instanceId);
    },
    [expandCard, updateNodes]
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
    const footprint = groupGridSize(0, false);
    const origin = {
      x: center.x - footprint.width / 2,
      y: center.y - footprint.height / 2,
    };
    let createdId: string | null = null;
    updateNodes((items) => {
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
      const ids = expandSelectionToGroups(items, selectedIds);
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
        next = node.parentId
          ? placeDetachedWindow(next, id)
          : next.map((item) => (item.id === id ? expandNode(item) : item));
      }
      return next;
    });
  }, [selectedIds, updateNodes]);

  const collapseSelection = useCallback(() => {
    updateNodes((items) =>
      items.map((node) =>
        selectedIds.has(node.id) ? collapseNode(node) : node
      )
    );
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
      if (event.key === 'Enter' && selectedIds.size === 1) {
        const instanceId = [...selectedIds][0];
        const current = documentRef.current.nodes.find(
          (node) => node.id === instanceId
        );
        if (current?.expanded && instanceId) collapseCard(instanceId);
        else if (instanceId && current?.parentId) {
          updateNodes((items) => placeDetachedWindow(items, instanceId));
        } else if (instanceId) expandCard(instanceId);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [collapseCard, deleteSelection, expandCard, selectedIds, updateNodes]);

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
      if (pendingViewport.current) {
        saveCanvasDocument(projectId, {
          ...documentRef.current,
          viewport: pendingViewport.current,
        });
      }
    },
    [projectId]
  );

  const empty = nodes.length === 0;
  const selectedNodes = nodes.filter((node) => selectedIds.has(node.id));
  const selectedExpanded =
    selectedNodes.filter(isSessionNode).length > 0 &&
    selectedNodes.filter(isSessionNode).every((node) => node.expanded);

  return (
    <SessionCanvasViewProvider value={viewContext}>
      <div
        ref={surfaceRef}
        className="canvas-surface relative h-full w-full"
        onClick={() => setSelectionMenu(null)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (selectedIds.size === 0) {
            setSelectionMenu(null);
            return;
          }
          setSelectionMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          nodesConnectable={false}
          edgesReconnectable={false}
          edgesFocusable={false}
          connectionMode={ConnectionMode.Loose}
          defaultEdgeOptions={SAME_SESSION_EDGE_OPTIONS}
          onNodesChange={handleNodesChange}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onNodeDoubleClick={handleNodeDoubleClick}
          onMove={handleMove}
          onMoveEnd={handleMoveEnd}
          fitView={documentState.viewport == null}
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          defaultViewport={documentState.viewport ?? undefined}
          minZoom={CANVAS_MIN_ZOOM}
          maxZoom={CANVAS_MAX_ZOOM}
          onlyRenderVisibleElements
          elevateNodesOnSelect={false}
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
            onImportByProject={() => setImportMode('project')}
            onImportByRecent={() => setImportMode('recent')}
            onImportByAgent={() => setImportMode('agent')}
            onFitView={() => void fitView({ padding: 0.2, duration: 300 })}
            onAutoArrange={autoArrange}
            onExpandSelection={expandSelection}
            onCollapseSelection={collapseSelection}
            onDeleteSelection={deleteSelection}
          />
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
        {selectionMenu ? (
          <div
            className="fixed z-50 min-w-36 rounded-xl border border-border bg-[var(--surface-card-strong)] p-1 shadow-[var(--shadow-popover)]"
            style={{ left: selectionMenu.x, top: selectionMenu.y }}
          >
            <button
              type="button"
              className="flex w-full rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-control-hover)]"
              onClick={() => {
                updateNodes((items) => groupSelection(items, selectedIds));
                setSelectionMenu(null);
              }}
            >
              {t('hubCanvas.groupSelection')}
            </button>
            <button
              type="button"
              className="flex w-full rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-control-hover)]"
              onClick={() => {
                updateNodes((items) => {
                  const expanded = expandSelectionToGroups(items, selectedIds);
                  const roots = items.filter(
                    (node) =>
                      expanded.has(node.id) &&
                      (!node.parentId || !expanded.has(node.parentId))
                  );
                  const moves = packLayout(roots);
                  let next = items;
                  for (const move of moves) {
                    const node = nodeById(next, move.id);
                    if (!node) continue;
                    const dx = move.x - node.x;
                    const dy = move.y - node.y;
                    next = isGroupNode(node)
                      ? applyDescendantDelta(next, node.id, dx, dy)
                      : next.map((item) =>
                          item.id === node.id
                            ? { ...item, x: move.x, y: move.y }
                            : item
                        );
                  }
                  return next;
                });
                setSelectionMenu(null);
              }}
            >
              {t('hubCanvas.arrangeSelection')}
            </button>
            {selectedNodes.some(isGroupNode) ? (
              <button
                type="button"
                className="flex w-full rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-control-hover)]"
                onClick={() => {
                  updateNodes((items) => {
                    let next = items;
                    for (const node of items.filter(
                      (item) => selectedIds.has(item.id) && isGroupNode(item)
                    )) {
                      next = dissolveCanvasGroup(next, node.id);
                    }
                    return next;
                  });
                  setSelectionMenu(null);
                }}
              >
                {t('hubCanvas.dissolveGroup')}
              </button>
            ) : null}
          </div>
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
