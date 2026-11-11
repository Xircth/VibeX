import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistFrontendPreference = vi.hoisted(() => vi.fn());

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference,
}));

import { CARD_HEIGHT, CARD_WIDTH } from './canvasModel';
import {
  CANVAS_BUNDLE_KEY,
  canvasDocumentStorageKey,
  createCanvasBoard,
  deleteCanvasBoard,
  flushCanvasDocumentPersist,
  getActiveCanvasEntry,
  loadCanvasDocument,
  loadCanvasWorkspace,
  renameCanvasBoard,
  saveCanvasDocument,
  saveCanvasWorkspace,
  saveMinimapVisible,
  selectCanvasBoard,
} from './canvasStorage';

describe('canvasStorage', () => {
  const projectId = 'project-1';

  beforeEach(() => {
    flushCanvasDocumentPersist();
    localStorage.clear();
    persistFrontendPreference.mockReset();
  });

  it('returns an empty document when nothing is stored', () => {
    expect(loadCanvasDocument(projectId)).toEqual({
      nodes: [],
      viewport: null,
      listCollapsed: false,
      minimapVisible: true,
      relativeChildren: true,
    });
  });

  it('keeps the minimap open until it is explicitly hidden', () => {
    expect(loadCanvasDocument(projectId).minimapVisible).toBe(true);
    saveMinimapVisible(false);
    expect(loadCanvasDocument(projectId).minimapVisible).toBe(false);
  });

  it('round-trips a document and drops malformed nodes', () => {
    saveCanvasDocument(projectId, {
      nodes: [
        {
          id: 'ok',
          kind: 'session',
          sessionId: 'ok',
          parentId: null,
          name: '',
          createdAt: 0,
          showAll: false,
          x: 12,
          y: 24,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          expanded: false,
        },
      ],
      viewport: { x: 1, y: 2, zoom: 1.25 },
      listCollapsed: true,
      minimapVisible: true,
    });

    const raw = JSON.parse(
      localStorage.getItem(canvasDocumentStorageKey(projectId)) ?? '{}'
    ) as { nodes: unknown[] };
    raw.nodes.push({ sessionId: '', x: 0, y: 0 });
    localStorage.setItem(
      canvasDocumentStorageKey(projectId),
      JSON.stringify(raw)
    );

    const loaded = loadCanvasDocument(projectId);
    expect(loaded.nodes).toEqual([
      {
        id: 'ok',
        kind: 'session',
        sessionId: 'ok',
        parentId: null,
        name: '',
        createdAt: 0,
        showAll: false,
        collapsed: false,
        openedFromId: null,
        x: 12,
        y: 24,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        expanded: false,
      },
    ]);
    expect(loaded.viewport).toEqual({ x: 1, y: 2, zoom: 1.25 });
    expect(loaded.listCollapsed).toBe(true);
    expect(loaded.minimapVisible).toBe(true);
  });

  it('writes the board into the durable preference bundle', () => {
    saveCanvasDocument(projectId, {
      nodes: [],
      viewport: { x: 4, y: 8, zoom: 1 },
      listCollapsed: false,
      minimapVisible: false,
    });
    expect(persistFrontendPreference).not.toHaveBeenCalled();
    flushCanvasDocumentPersist();

    expect(persistFrontendPreference).toHaveBeenCalledWith(
      CANVAS_BUNDLE_KEY,
      expect.objectContaining({
        [projectId]: expect.objectContaining({
          viewport: { x: 4, y: 8, zoom: 1 },
        }),
      })
    );
    const bundle = JSON.parse(
      localStorage.getItem(CANVAS_BUNDLE_KEY) ?? '{}'
    ) as Record<string, { viewport: unknown }>;
    expect(bundle[projectId]?.viewport).toEqual({ x: 4, y: 8, zoom: 1 });
  });

  it('restores a document from the preference bundle after the per-project key is gone', () => {
    saveCanvasDocument(projectId, {
      nodes: [
        {
          id: 'ok',
          kind: 'session',
          sessionId: 'ok',
          parentId: null,
          name: '',
          createdAt: 0,
          showAll: false,
          x: 12,
          y: 24,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          expanded: false,
        },
      ],
      viewport: { x: 1, y: 2, zoom: 1 },
      listCollapsed: false,
      minimapVisible: false,
    });
    localStorage.removeItem(canvasDocumentStorageKey(projectId));

    expect(loadCanvasDocument(projectId).nodes).toHaveLength(1);
    expect(loadCanvasDocument(projectId).viewport).toEqual({
      x: 1,
      y: 2,
      zoom: 1,
    });
  });

  it('clamps a restored zoom into the board range', () => {
    localStorage.setItem(
      canvasDocumentStorageKey(projectId),
      JSON.stringify({
        nodes: [],
        viewport: { x: 0, y: 0, zoom: 9 },
      })
    );
    expect(loadCanvasDocument(projectId).viewport?.zoom).toBe(2);
  });

  it('flushes rapid board saves into a single preference write', () => {
    saveCanvasDocument(projectId, {
      nodes: [],
      viewport: { x: 1, y: 1, zoom: 1 },
      listCollapsed: false,
      minimapVisible: true,
    });
    saveCanvasDocument(projectId, {
      nodes: [],
      viewport: { x: 2, y: 2, zoom: 1 },
      listCollapsed: false,
      minimapVisible: true,
    });
    flushCanvasDocumentPersist();
    expect(persistFrontendPreference).toHaveBeenCalledTimes(1);
    expect(persistFrontendPreference).toHaveBeenCalledWith(
      CANVAS_BUNDLE_KEY,
      expect.objectContaining({
        [projectId]: expect.objectContaining({
          viewport: { x: 2, y: 2, zoom: 1 },
        }),
      })
    );
  });

  it('supports multiple named canvases with independent layout states', () => {
    saveCanvasDocument(projectId, {
      nodes: [
        {
          id: 'session-a',
          kind: 'session',
          sessionId: 'session-a',
          parentId: null,
          name: '',
          createdAt: 0,
          showAll: false,
          x: 40,
          y: 80,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          expanded: false,
        },
      ],
      viewport: { x: 10, y: 20, zoom: 1 },
      listCollapsed: false,
      minimapVisible: true,
    });

    let ws = loadCanvasWorkspace(projectId);
    expect(ws.canvases).toHaveLength(1);
    const firstId = ws.activeCanvasId;

    ws = createCanvasBoard(ws, '架构规划');
    expect(ws.canvases).toHaveLength(2);
    const secondId = ws.activeCanvasId;
    expect(secondId).not.toBe(firstId);
    expect(getActiveCanvasEntry(ws).name).toBe('架构规划');
    expect(getActiveCanvasEntry(ws).document.nodes).toHaveLength(0);

    saveCanvasWorkspace(projectId, ws);
    saveCanvasDocument(projectId, {
      nodes: [
        {
          id: 'session-b',
          kind: 'session',
          sessionId: 'session-b',
          parentId: null,
          name: '',
          createdAt: 0,
          showAll: false,
          x: 300,
          y: 400,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          expanded: false,
        },
      ],
      viewport: { x: -50, y: -100, zoom: 0.8 },
      listCollapsed: false,
      minimapVisible: true,
    });

    const reloaded = loadCanvasWorkspace(projectId);
    expect(reloaded.canvases).toHaveLength(2);
    expect(reloaded.activeCanvasId).toBe(secondId);
    expect(loadCanvasDocument(projectId).nodes[0]?.id).toBe('session-b');

    const switchedBack = selectCanvasBoard(reloaded, firstId);
    saveCanvasWorkspace(projectId, switchedBack);
    expect(loadCanvasDocument(projectId).nodes[0]?.id).toBe('session-a');
    expect(loadCanvasDocument(projectId).viewport).toEqual({
      x: 10,
      y: 20,
      zoom: 1,
    });

    const renamed = renameCanvasBoard(switchedBack, firstId, '日常开发');
    saveCanvasWorkspace(projectId, renamed);
    expect(loadCanvasWorkspace(projectId).canvases[0]?.name).toBe('日常开发');

    const afterDelete = deleteCanvasBoard(
      loadCanvasWorkspace(projectId),
      firstId
    );
    expect(afterDelete.canvases).toHaveLength(1);
    expect(afterDelete.activeCanvasId).toBe(secondId);
    // Cannot delete the last remaining canvas
    expect(deleteCanvasBoard(afterDelete, secondId).canvases).toHaveLength(1);
  });
});
