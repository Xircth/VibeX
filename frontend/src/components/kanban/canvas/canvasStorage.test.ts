import { beforeEach, describe, expect, it } from 'vitest';

import { CARD_HEIGHT, CARD_WIDTH } from './canvasModel';
import {
  canvasDocumentStorageKey,
  loadCanvasDocument,
  saveCanvasDocument,
} from './canvasStorage';

describe('canvasStorage', () => {
  const projectId = 'project-1';

  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty document when nothing is stored', () => {
    expect(loadCanvasDocument(projectId)).toEqual({
      nodes: [],
      viewport: null,
      listCollapsed: false,
      minimapVisible: false,
      relativeChildren: true,
    });
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
});
