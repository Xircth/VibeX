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

export const DEFAULT_CANVAS_DOCUMENT: SessionCanvasDocument = {
  nodes: [],
  viewport: null,
  listCollapsed: false,
  minimapVisible: true,
  relativeChildren: true,
  links: [],
  dismissedAutoLinks: [],
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
    : [];
  const dismissedAutoLinks = Array.isArray(record.dismissedAutoLinks)
    ? record.dismissedAutoLinks.filter(
        (item): item is string => typeof item === 'string' && item.length > 0
      )
    : [];
  const relativeChildren = record.relativeChildren === true;
  return {
    nodes: relativeChildren ? parsedNodes : toRelativeChildCoords(parsedNodes),
    viewport: parseViewport(record.viewport),
    listCollapsed: record.listCollapsed === true,
    minimapVisible: loadMinimapVisible(),
    relativeChildren: true,
    links: parsedLinks,
    dismissedAutoLinks,
  };
}

export function loadCanvasDocument(projectId: string): SessionCanvasDocument {
  if (!projectId) return { ...DEFAULT_CANVAS_DOCUMENT };
  const parsed =
    readStoredBundle()[projectId] ?? readJson(documentKey(projectId));
  return parseDocument(parsed);
}

export function saveCanvasDocument(
  projectId: string,
  document: SessionCanvasDocument
): void {
  if (!projectId) return;
  const stored = { ...document, relativeChildren: true };
  writeJson(documentKey(projectId), stored);
  const bundle = readStoredBundle();
  bundle[projectId] = stored;
  writeJson(CANVAS_BUNDLE_KEY, bundle);
  scheduleBundlePersist(bundle);
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
