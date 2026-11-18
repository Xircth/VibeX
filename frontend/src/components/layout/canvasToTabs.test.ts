import { describe, expect, it } from 'vitest';
import {
  createCanvasNode,
  createCanvasPanelNode,
  type SessionCanvasNode,
} from '@/components/kanban/canvas/canvasModel';
import {
  planCanvasTabsFromNodes,
  type CanvasSessionTabMeta,
} from './canvasToTabs';

function sessionNode(
  sessionId: string,
  createdAt: number,
  expanded = false
): SessionCanvasNode {
  return {
    ...createCanvasNode(sessionId, { x: 0, y: 0 }, sessionId),
    createdAt,
    expanded,
  };
}

function meta(workspaceId: string, updatedAt: number): CanvasSessionTabMeta {
  return { workspaceId, updatedAt, title: null, agentId: null };
}

describe('planCanvasTabsFromNodes', () => {
  it('keeps the 10 most active nodes and activates the newest last', () => {
    const nodes = Array.from({ length: 12 }, (_, index) =>
      sessionNode(`s${index}`, index)
    );
    const sessions = new Map(
      nodes.map((node, index) => [
        node.sessionId,
        meta('workspace-1', index * 10),
      ])
    );

    const requests = planCanvasTabsFromNodes(nodes, sessions, { now: 1_000 });

    expect(requests).toHaveLength(10);
    expect(requests.map((request) => request.activate)).toEqual([
      ...Array(9).fill(false),
      true,
    ]);
    expect(requests[0]).toMatchObject({ kind: 'session', sessionId: 's2' });
    expect(requests[9]).toMatchObject({ kind: 'session', sessionId: 's11' });
  });

  it('ranks an expanded window above a stale session update', () => {
    const nodes = [sessionNode('stale', 100), sessionNode('open', 50, true)];
    const sessions = new Map([
      ['stale', meta('workspace-1', 900)],
      ['open', meta('workspace-1', 10)],
    ]);

    const requests = planCanvasTabsFromNodes(nodes, sessions, { now: 1_000 });

    expect(
      requests.map((request) => request.kind === 'session' && request.sessionId)
    ).toEqual(['stale', 'open']);
    expect(requests[1]?.activate).toBe(true);
  });

  it('drops groups, duplicate cards, and sessions with no workspace', () => {
    const duplicate = sessionNode('same', 20);
    const nodes: SessionCanvasNode[] = [
      { ...sessionNode('group-session', 999), kind: 'group' },
      duplicate,
      { ...duplicate, id: 'same-copy', expanded: true },
      sessionNode('missing', 800),
      sessionNode('kept', 30),
    ];
    const sessions = new Map([
      ['same', meta('workspace-1', 40)],
      ['kept', meta('workspace-1', 30)],
    ]);

    const requests = planCanvasTabsFromNodes(nodes, sessions, { now: 1_000 });

    expect(
      requests.map((request) => request.kind === 'session' && request.sessionId)
    ).toEqual(['kept', 'same']);
    expect(requests[1]?.activate).toBe(true);
  });

  it('includes panel nodes and passes their component through', () => {
    const panel = {
      ...createCanvasPanelNode({
        panelId: 'files',
        panelComponent: 'FileTree',
        panelTitle: 'Files',
        panelParams: { root: 'src' },
        position: { x: 0, y: 0 },
        expanded: true,
        id: 'panel-files',
      }),
      createdAt: 10,
    };
    const requests = planCanvasTabsFromNodes(
      [sessionNode('older', 1), panel],
      new Map([['older', meta('workspace-1', 1)]]),
      { now: 1_000 }
    );

    expect(requests[0]).toMatchObject({
      kind: 'session',
      sessionId: 'older',
      activate: false,
    });
    expect(requests[1]).toEqual({
      kind: 'panel',
      panelId: 'files',
      title: 'Files',
      component: 'FileTree',
      params: { root: 'src', __component: 'FileTree' },
      activate: true,
    });
  });
});
