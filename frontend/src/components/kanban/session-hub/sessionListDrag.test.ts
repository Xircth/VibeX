import { describe, expect, it } from 'vitest';
import {
  dragEndClientPoint,
  isPointOverCanvasDrop,
  snapDragOverlayToCursor,
} from './sessionListDrag';

describe('dragEndClientPoint', () => {
  it('uses the translated overlay rect when present', () => {
    expect(
      dragEndClientPoint({
        active: {
          rect: {
            current: {
              translated: { left: 10, top: 20, width: 40, height: 20 },
            },
          },
        },
        delta: { x: 0, y: 0 },
        activatorEvent: null,
      } as never)
    ).toEqual({ x: 30, y: 30 });
  });

  it('falls back to the activator pointer plus delta', () => {
    expect(
      dragEndClientPoint({
        active: { rect: { current: { translated: null } } },
        delta: { x: 12, y: 8 },
        activatorEvent: { clientX: 100, clientY: 40 },
      } as never)
    ).toEqual({ x: 112, y: 48 });
  });
});

describe('snapDragOverlayToCursor', () => {
  it('centers the overlay on the pointer', () => {
    expect(
      snapDragOverlayToCursor({
        activatorEvent: { clientX: 120, clientY: 80 } as MouseEvent,
        active: null,
        activeNodeRect: {
          left: 10,
          top: 20,
          width: 40,
          height: 20,
          right: 50,
          bottom: 40,
        },
        draggingNodeRect: {
          left: 40,
          top: 30,
          width: 40,
          height: 20,
          right: 80,
          bottom: 50,
        },
        containerNodeRect: null,
        overlayNodeRect: null,
        over: null,
        scrollableAncestors: [],
        scrollableAncestorRects: [],
        transform: { x: 30, y: 10, scaleX: 1, scaleY: 1 },
        windowRect: null,
      })
    ).toEqual({ x: 90, y: 50, scaleX: 1, scaleY: 1 });
  });
});

describe('isPointOverCanvasDrop', () => {
  it('rejects hits inside the session list and accepts the canvas surface', () => {
    const canvas = document.createElement('div');
    canvas.className = 'canvas-surface';
    const list = document.createElement('div');
    list.className = 'session-canvas-floating-panel';
    canvas.append(list);
    const card = document.createElement('div');
    list.append(card);
    const pane = document.createElement('div');
    canvas.append(pane);

    expect(isPointOverCanvasDrop(card)).toBe(false);
    expect(isPointOverCanvasDrop(pane)).toBe(true);
    expect(isPointOverCanvasDrop(null)).toBe(false);
  });
});
