import { describe, expect, it } from 'vitest';
import { canvasNodesMatch, snapshotCanvasNodes } from './canvasHistory';
import { createCanvasNode, createCanvasPanelNode } from './canvasModel';

describe('canvasHistory', () => {
  it('clones nodes so later edits do not change the snapshot', () => {
    const node = createCanvasNode('sess-a', { x: 1, y: 2 }, 'a');
    const snapshot = snapshotCanvasNodes([node]);
    node.x = 99;
    expect(snapshot[0]?.x).toBe(1);
    expect(canvasNodesMatch(snapshot, [node])).toBe(false);
    expect(canvasNodesMatch(snapshot, snapshotCanvasNodes(snapshot))).toBe(
      true
    );
  });

  it('treats a showAll toggle as a history change', () => {
    const node = createCanvasNode('sess-a', { x: 1, y: 2 }, 'a');
    expect(canvasNodesMatch([node], [{ ...node, showAll: true }])).toBe(false);
  });

  it('treats a panelParams change as a history change', () => {
    const node = createCanvasPanelNode({
      panelId: 'term-1',
      panelComponent: 'terminal',
      panelTitle: 'Terminal',
      panelParams: { cwd: '/home' },
      position: { x: 0, y: 0 },
    });
    const modified = {
      ...node,
      panelParams: { cwd: '/tmp' },
    };
    expect(canvasNodesMatch([node], [modified])).toBe(false);
  });

  it('treats identical panelParams as matching', () => {
    const node = createCanvasPanelNode({
      panelId: 'term-1',
      panelComponent: 'terminal',
      panelTitle: 'Terminal',
      panelParams: { cwd: '/home' },
      position: { x: 0, y: 0 },
    });
    const clone = { ...node, panelParams: { ...node.panelParams } };
    expect(canvasNodesMatch([node], [clone])).toBe(true);
  });
});
