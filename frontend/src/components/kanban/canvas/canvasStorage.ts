import type { JsonValue } from 'shared/types';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  isCanvasHandleSide,
  type SessionCanvasLink,
  type SessionCanvasNode,
} from './canvasModel';
import { toRelativeChildCoords } from './canvasGrouping';

export interface SessionCanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SessionCanvasDocument {
  nodes: SessionCanvasNode[];
  viewport: SessionCanvasViewport | null;
  listCollapsed: boolean;
  minimapVisible: boolean;
  relativeChildren?: boolean;
  links?: SessionCanvasLink[];
  dismissedAutoLinks?: string[];
}

export const DEFAULT_CANVAS_BOARD_ID = 'default' as const;

export interface SessionCanvasBoardEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  document: SessionCanvasDocument;
}

export interface SessionCanvasWorkspace {
  activeCanvasId: string;
  canvases: SessionCanvasBoardEntry[];
}

export const DEFAULT_CANVAS_DOCUMENT: SessionCanvasDocument = {
  nodes: [],
  viewport: null,
  listCollapsed: false,
  minimapVisible: true,
  relativeChildren: true,
};

const DOCUMENT_KEY_PREFIX = 'vibex:kanban-canvas:';
export const CANVAS_BUNDLE_KEY = 'vibex:kanban-canvas' as const;
const MINIMAP_KEY = 'vibex:kanban-canvas-minimap';

function documentKey(projectId: string): string {
  return `${DOCUMENT_KEY_PREFIX}${projectId}`;
}

function readJson(key: string): unknown {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / private-mode failures */
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseNode(value: unknown): SessionCanvasNode | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'group' ? 'group' : 'session';
  const sessionId =
    typeof record.sessionId === 'string' ? record.sessionId : '';
  const panelComponent =
    typeof record.panelComponent === 'string' &&
    record.panelComponent.length > 0
      ? record.panelComponent
      : undefined;
  if (kind === 'session' && sessionId.length === 0 && !panelComponent) {
    return null;
  }
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) return null;
  const expanded = record.expanded === true;
  const width = isFiniteNumber(record.width)
    ? record.width
    : expanded
      ? DETAIL_MIN_WIDTH
      : CARD_WIDTH;
  const height = isFiniteNumber(record.height)
    ? record.height
    : expanded
      ? DETAIL_MIN_HEIGHT
      : CARD_HEIGHT;
  const panelId =
    typeof record.panelId === 'string' && record.panelId.length > 0
      ? record.panelId
      : undefined;
  const panelTitle =
    typeof record.panelTitle === 'string' ? record.panelTitle : undefined;
  const panelParams =
    record.panelParams &&
    typeof record.panelParams === 'object' &&
    !Array.isArray(record.panelParams)
      ? { ...(record.panelParams as Record<string, unknown>) }
      : undefined;
  const id =
    typeof record.id === 'string' && record.id.length > 0
      ? record.id
      : sessionId || panelId || `group-${record.x}-${record.y}`;
  return {
    id,
    kind,
    sessionId,
    parentId:
      typeof record.parentId === 'string' && record.parentId.length > 0
        ? record.parentId
        : null,
    name: typeof record.name === 'string' ? record.name : '',
    createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : 0,
    showAll: record.showAll === true,
    collapsed: record.collapsed === true,
    ...(isFiniteNumber(record.manualColumns) && record.manualColumns >= 1
      ? { manualColumns: Math.round(record.manualColumns) }
      : {}),
    ...(isFiniteNumber(record.manualRows) && record.manualRows >= 1
      ? { manualRows: Math.round(record.manualRows) }
      : {}),
    x: record.x,
    y: record.y,
    width: Math.max(width, expanded ? DETAIL_MIN_WIDTH : 1),
    height: Math.max(height, expanded ? DETAIL_MIN_HEIGHT : 1),
    expanded,
    openedFromId:
      typeof record.openedFromId === 'string' && record.openedFromId.length > 0
        ? record.openedFromId
        : null,
    ...(panelId ? { panelId } : {}),
    ...(panelComponent ? { panelComponent } : {}),
    ...(panelTitle !== undefined ? { panelTitle } : {}),
    ...(panelParams ? { panelParams } : {}),
  };
}

function parseLink(value: unknown): SessionCanvasLink | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const sourceId =
    typeof record.sourceId === 'string' && record.sourceId.length > 0
      ? record.sourceId
      : '';
  const targetId =
    typeof record.targetId === 'string' && record.targetId.length > 0
      ? record.targetId
      : '';
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const sourceHandle = isCanvasHandleSide(record.sourceHandle)
    ? record.sourceHandle
    : undefined;
  const targetHandle = isCanvasHandleSide(record.targetHandle)
    ? record.targetHandle
    : undefined;
  const id =
    typeof record.id === 'string' && record.id.length > 0
      ? record.id
      : `link-${sourceId}-${sourceHandle ?? 'auto'}-${targetId}-${targetHandle ?? 'auto'}`;
  return {
    id,
    sourceId,
    targetId,
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(targetHandle ? { targetHandle } : {}),
  };
}

function parseViewport(value: unknown): SessionCanvasViewport | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    !isFiniteNumber(record.x) ||
    !isFiniteNumber(record.y) ||
    !isFiniteNumber(record.zoom)
  ) {
    return null;
  }
  return {
    x: record.x,
    y: record.y,
    zoom: Math.min(Math.max(record.zoom, CANVAS_MIN_ZOOM), CANVAS_MAX_ZOOM),
  };
}

export const CANVAS_DOCUMENT_SAVE_DELAY_MS = 500;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBundle: Record<string, unknown> | null = null;

function readStoredBundle(): Record<string, unknown> {
  const bundled = readJson(CANVAS_BUNDLE_KEY);
  return bundled && typeof bundled === 'object' && !Array.isArray(bundled)
    ? { ...(bundled as Record<string, unknown>) }
    : {};
}

function scheduleBundlePersist(bundle: Record<string, unknown>) {
  pendingBundle = bundle;
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const next = pendingBundle;
    pendingBundle = null;
    if (next) {
      persistFrontendPreference(CANVAS_BUNDLE_KEY, { ...next } as JsonValue);
    }
  }, CANVAS_DOCUMENT_SAVE_DELAY_MS);
}

export function flushCanvasDocumentPersist(): void {
  if (persistTimer == null) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  const next = pendingBundle;
  pendingBundle = null;
  if (next) {
    persistFrontendPreference(CANVAS_BUNDLE_KEY, { ...next } as JsonValue);
  }
}

function parseDocument(value: unknown): SessionCanvasDocument {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_CANVAS_DOCUMENT, minimapVisible: loadMinimapVisible() };
  }
  const record = value as Record<string, unknown>;
  const parsedNodes = Array.isArray(record.nodes)
    ? record.nodes
        .map(parseNode)
        .filter((node): node is SessionCanvasNode => node !== null)
    : [];
  const parsedLinks = Array.isArray(record.links)
    ? record.links
        .map(parseLink)
        .filter((link): link is SessionCanvasLink => link !== null)
    : undefined;
  const dismissedAutoLinks = Array.isArray(record.dismissedAutoLinks)
    ? record.dismissedAutoLinks.filter(
        (item): item is string => typeof item === 'string' && item.length > 0
      )
    : undefined;
  const relativeChildren = record.relativeChildren === true;
  return {
    nodes: relativeChildren ? parsedNodes : toRelativeChildCoords(parsedNodes),
    viewport: parseViewport(record.viewport),
    listCollapsed: record.listCollapsed === true,
    minimapVisible: loadMinimapVisible(),
    relativeChildren: true,
    ...(parsedLinks !== undefined ? { links: parsedLinks } : {}),
    ...(dismissedAutoLinks !== undefined ? { dismissedAutoLinks } : {}),
  };
}

function createDefaultWorkspace(
  document?: SessionCanvasDocument
): SessionCanvasWorkspace {
  return {
    activeCanvasId: DEFAULT_CANVAS_BOARD_ID,
    canvases: [
      {
        id: DEFAULT_CANVAS_BOARD_ID,
        name: '',
        createdAt: 0,
        updatedAt: 0,
        document: document ?? {
          ...DEFAULT_CANVAS_DOCUMENT,
          minimapVisible: loadMinimapVisible(),
        },
      },
    ],
  };
}

function parseBoardEntry(value: unknown): SessionCanvasBoardEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === 'string' && record.id.trim().length > 0
      ? record.id.trim()
      : '';
  if (!id) return null;
  return {
    id,
    name: typeof record.name === 'string' ? record.name : '',
    createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : 0,
    updatedAt: isFiniteNumber(record.updatedAt) ? record.updatedAt : 0,
    document: parseDocument(record.document),
  };
}

function parseWorkspace(value: unknown): SessionCanvasWorkspace {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.canvases)) {
      const seen = new Set<string>();
      const canvases: SessionCanvasBoardEntry[] = [];
      for (const item of record.canvases) {
        const entry = parseBoardEntry(item);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        canvases.push(entry);
      }
      if (canvases.length > 0) {
        const requestedActive =
          typeof record.activeCanvasId === 'string'
            ? record.activeCanvasId
            : '';
        const activeCanvasId = seen.has(requestedActive)
          ? requestedActive
          : canvases[0].id;
        return { activeCanvasId, canvases };
      }
    }
  }
  return createDefaultWorkspace(parseDocument(value));
}

export function getActiveCanvasEntry(
  workspace: SessionCanvasWorkspace
): SessionCanvasBoardEntry {
  return (
    workspace.canvases.find((entry) => entry.id === workspace.activeCanvasId) ??
    workspace.canvases[0] ??
    createDefaultWorkspace().canvases[0]
  );
}

function serializeWorkspace(
  workspace: SessionCanvasWorkspace
): Record<string, unknown> {
  const normalizedCanvases =
    workspace.canvases.length > 0
      ? workspace.canvases.map((entry) => ({
          ...entry,
          document: { ...entry.document, relativeChildren: true },
        }))
      : createDefaultWorkspace().canvases;
  const active =
    normalizedCanvases.find((entry) => entry.id === workspace.activeCanvasId) ??
    normalizedCanvases[0];

  if (
    normalizedCanvases.length === 1 &&
    active.id === DEFAULT_CANVAS_BOARD_ID &&
    active.name.trim().length === 0
  ) {
    return { ...active.document, relativeChildren: true };
  }

  return {
    ...active.document,
    relativeChildren: true,
    version: 2,
    activeCanvasId: active.id,
    canvases: normalizedCanvases,
  };
}

export function loadCanvasWorkspace(projectId: string): SessionCanvasWorkspace {
  if (!projectId) return createDefaultWorkspace({ ...DEFAULT_CANVAS_DOCUMENT });
  const parsed =
    readStoredBundle()[projectId] ?? readJson(documentKey(projectId));
  return parseWorkspace(parsed);
}

export function saveCanvasWorkspace(
  projectId: string,
  workspace: SessionCanvasWorkspace
): void {
  if (!projectId) return;
  const stored = serializeWorkspace(workspace);
  writeJson(documentKey(projectId), stored);
  const bundle = readStoredBundle();
  bundle[projectId] = stored;
  writeJson(CANVAS_BUNDLE_KEY, bundle);
  scheduleBundlePersist(bundle);
}

export function updateWorkspaceActiveDocument(
  workspace: SessionCanvasWorkspace,
  document: SessionCanvasDocument
): SessionCanvasWorkspace {
  const active = getActiveCanvasEntry(workspace);
  const isSingleDefault =
    workspace.canvases.length === 1 &&
    active.id === DEFAULT_CANVAS_BOARD_ID &&
    active.name.trim().length === 0;
  return {
    ...workspace,
    activeCanvasId: active.id,
    canvases: workspace.canvases.map((entry) =>
      entry.id === active.id
        ? {
            ...entry,
            updatedAt: isSingleDefault ? entry.updatedAt : Date.now(),
            document,
          }
        : entry
    ),
  };
}

let boardIdSequence = 0;

function generateCanvasBoardId(existingIds: ReadonlySet<string>): string {
  let candidate = '';
  do {
    boardIdSequence += 1;
    candidate = `canvas-${Date.now().toString(36)}-${boardIdSequence.toString(36)}`;
  } while (existingIds.has(candidate));
  return candidate;
}

export function createCanvasBoard(
  workspace: SessionCanvasWorkspace,
  name = ''
): SessionCanvasWorkspace {
  const active = getActiveCanvasEntry(workspace);
  const existingIds = new Set(workspace.canvases.map((entry) => entry.id));
  const id = generateCanvasBoardId(existingIds);
  const now = Date.now();
  const nextEntry: SessionCanvasBoardEntry = {
    id,
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    document: {
      ...DEFAULT_CANVAS_DOCUMENT,
      listCollapsed: active.document.listCollapsed,
      minimapVisible: active.document.minimapVisible,
      links: [],
      dismissedAutoLinks: [],
    },
  };
  return {
    activeCanvasId: id,
    canvases: [...workspace.canvases, nextEntry],
  };
}

export function selectCanvasBoard(
  workspace: SessionCanvasWorkspace,
  canvasId: string
): SessionCanvasWorkspace {
  if (canvasId === workspace.activeCanvasId) return workspace;
  if (!workspace.canvases.some((entry) => entry.id === canvasId)) {
    return workspace;
  }
  return {
    ...workspace,
    activeCanvasId: canvasId,
  };
}

export function renameCanvasBoard(
  workspace: SessionCanvasWorkspace,
  canvasId: string,
  name: string
): SessionCanvasWorkspace {
  const trimmed = name.trim();
  let changed = false;
  const canvases = workspace.canvases.map((entry) => {
    if (entry.id !== canvasId) return entry;
    if (entry.name === trimmed) return entry;
    changed = true;
    return {
      ...entry,
      name: trimmed,
      updatedAt: Date.now(),
    };
  });
  return changed ? { ...workspace, canvases } : workspace;
}

export function deleteCanvasBoard(
  workspace: SessionCanvasWorkspace,
  canvasId: string
): SessionCanvasWorkspace {
  if (workspace.canvases.length <= 1) return workspace;
  const index = workspace.canvases.findIndex((entry) => entry.id === canvasId);
  if (index === -1) return workspace;
  const canvases = workspace.canvases.filter((entry) => entry.id !== canvasId);
  const activeCanvasId =
    workspace.activeCanvasId === canvasId
      ? canvases[Math.min(index, canvases.length - 1)].id
      : workspace.activeCanvasId;
  return {
    activeCanvasId,
    canvases,
  };
}

export function loadCanvasDocument(projectId: string): SessionCanvasDocument {
  if (!projectId) return { ...DEFAULT_CANVAS_DOCUMENT };
  return getActiveCanvasEntry(loadCanvasWorkspace(projectId)).document;
}

export function saveCanvasDocument(
  projectId: string,
  document: SessionCanvasDocument
): void {
  if (!projectId) return;
  const currentWorkspace = loadCanvasWorkspace(projectId);
  const nextWorkspace = updateWorkspaceActiveDocument(
    currentWorkspace,
    document
  );
  saveCanvasWorkspace(projectId, nextWorkspace);
}

export function loadMinimapVisible(): boolean {
  const parsed = readJson(MINIMAP_KEY);
  if (parsed === null) return true;
  return parsed === true;
}

export function saveMinimapVisible(visible: boolean): void {
  writeJson(MINIMAP_KEY, visible);
}

export function canvasDocumentStorageKey(projectId: string): string {
  return documentKey(projectId);
}
