import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
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
}

export const DEFAULT_CANVAS_DOCUMENT: SessionCanvasDocument = {
  nodes: [],
  viewport: null,
  listCollapsed: false,
  minimapVisible: false,
  relativeChildren: true,
};

const DOCUMENT_KEY_PREFIX = 'vibex:kanban-canvas:';
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
  if (kind === 'session' && sessionId.length === 0) {
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
  const id =
    typeof record.id === 'string' && record.id.length > 0
      ? record.id
      : sessionId || `group-${record.x}-${record.y}`;
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
    x: record.x,
    y: record.y,
    width: Math.max(width, expanded ? DETAIL_MIN_WIDTH : 1),
    height: Math.max(height, expanded ? DETAIL_MIN_HEIGHT : 1),
    expanded,
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

export function loadCanvasDocument(projectId: string): SessionCanvasDocument {
  if (!projectId) return { ...DEFAULT_CANVAS_DOCUMENT };
  const parsed = readJson(documentKey(projectId));
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_CANVAS_DOCUMENT, minimapVisible: loadMinimapVisible() };
  }
  const record = parsed as Record<string, unknown>;
  const parsedNodes = Array.isArray(record.nodes)
    ? record.nodes
        .map(parseNode)
        .filter((node): node is SessionCanvasNode => node !== null)
    : [];
  const relativeChildren = record.relativeChildren === true;
  return {
    nodes: relativeChildren ? parsedNodes : toRelativeChildCoords(parsedNodes),
    viewport: parseViewport(record.viewport),
    listCollapsed: record.listCollapsed === true,
    minimapVisible:
      typeof record.minimapVisible === 'boolean'
        ? record.minimapVisible
        : loadMinimapVisible(),
    relativeChildren: true,
  };
}

export function saveCanvasDocument(
  projectId: string,
  document: SessionCanvasDocument
): void {
  if (!projectId) return;
  writeJson(documentKey(projectId), { ...document, relativeChildren: true });
}

export function loadMinimapVisible(): boolean {
  const parsed = readJson(MINIMAP_KEY);
  return parsed === true;
}

export function saveMinimapVisible(visible: boolean): void {
  writeJson(MINIMAP_KEY, visible);
}

export function canvasDocumentStorageKey(projectId: string): string {
  return documentKey(projectId);
}
