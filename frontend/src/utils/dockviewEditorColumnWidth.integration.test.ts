import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { isEditorGroup } from './dockviewGroupPolicy';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import { installEditorColumnWidthRebalance } from './dockviewEditorGroup';
import {
  addGroupBelowEditorGroups,
  terminalShelfHeight,
} from './dockviewEditorSplit';
import { settleDockviewGroupWidths } from './dockviewStartupSizing';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function createApi(width = 1800): DockviewApi {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(width, 800, true);
  return api;
}

function buildColumns(api: DockviewApi) {
  const first = api.addPanel({
    id: 'b1',
    component: 'preview',
    title: 'B1',
  });
  (first.group as { id: string }).id = 'group-editor-1';
  syncDockviewGroupRegistry(api);

  const fileTree = api.addGroup({
    id: 'group-left',
    referencePanel: first,
    direction: 'left',
    initialWidth: 220,
  });
  api.addPanel({
    id: 'file-tree',
    component: 'file-tree',
    title: 'Files',
    position: { referenceGroup: fileTree, direction: 'within' },
  });

  const session = api.addGroup({
    id: 'group-right',
    referencePanel: first,
    direction: 'right',
    initialWidth: 434,
  });
  api.addPanel({
    id: 'ai-chat',
    component: 'ai-chat',
    title: 'Sessions',
    position: { referenceGroup: session, direction: 'within' },
  });

  const editors = [first.group];
  let reference = first;
  for (const [id, panelId] of [
    ['group-editor-2', 'b2'],
    ['group-editor-3', 'b3'],
    ['group-editor-4', 'b4'],
  ] as const) {
    const group = api.addGroup({
      id,
      referencePanel: reference,
      direction: 'right',
    });
    editors.push(group);
    reference = api.addPanel({
      id: panelId,
      component: 'preview',
      title: panelId,
      position: { referenceGroup: group, direction: 'within' },
    });
  }

  settleDockviewGroupWidths([
    { group: fileTree, width: 220 },
    { group: session, width: 434 },
    { group: editors[0], width: 220 },
    { group: editors[1], width: 280 },
    { group: editors[2], width: 300 },
    { group: editors[3], width: 346 },
  ]);

  return { fileTree, session };
}

function visibleEditors(api: DockviewApi) {
  return api.groups.filter(
    (group) => isEditorGroup(group) && group.api.isVisible
  );
}

function expectNear(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(8);
}

describe('editor column close widths', () => {
  it('shares closed B-column width across the remaining B columns', () => {
    const api = createApi();
    const { fileTree, session } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    const dockBefore = fileTree.api.width;
    const sessionBefore = session.api.width;
    const sumBefore = visibleEditors(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    api.removePanel(api.getPanel('b2')!);
    api.removePanel(api.getPanel('b4')!);

    const remaining = visibleEditors(api);
    expect(remaining).toHaveLength(2);
    expectNear(fileTree.api.width, dockBefore);
    expectNear(session.api.width, sessionBefore);
    for (const group of remaining) {
      expectNear(group.api.width, sumBefore / 2);
    }
    rebalance.dispose();
    api.dispose();
  });

  it('gives the whole B zone to the last remaining column', () => {
    const api = createApi();
    const { fileTree, session } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    const dockBefore = fileTree.api.width;
    const sessionBefore = session.api.width;
    const sumBefore = visibleEditors(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    api.removePanel(api.getPanel('b2')!);
    api.removePanel(api.getPanel('b3')!);
    api.removePanel(api.getPanel('b4')!);

    const remaining = visibleEditors(api);
    expect(remaining).toHaveLength(1);
    expectNear(remaining[0]!.api.width, sumBefore);
    expectNear(fileTree.api.width, dockBefore);
    expectNear(session.api.width, sessionBefore);
    rebalance.dispose();
    api.dispose();
  });

  it('lets the session absorb the width when the last B column closes', () => {
    const api = createApi();
    const { fileTree, session } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    const sessionBefore = session.api.width;

    for (const panelId of ['b1', 'b2', 'b3', 'b4']) {
      const panel = api.getPanel(panelId);
      if (panel) api.removePanel(panel);
    }

    expect(visibleEditors(api)).toHaveLength(0);
    expect(session.api.width).toBeGreaterThan(sessionBefore + 50);
    expect(fileTree.api.width).toBeGreaterThan(0);
    rebalance.dispose();
    api.dispose();
  });

  it('keeps the shelf height and side columns when a B column closes', () => {
    const api = createApi();
    const { fileTree, session } = buildColumns(api);
    const editors = visibleEditors(api);
    const shelf = addGroupBelowEditorGroups(api, editors, {
      id: 'group-editor-5',
      height: terminalShelfHeight(api.height),
    });
    api.addPanel({
      id: 'terminal:1',
      component: 'terminal',
      title: 'Terminal',
      position: { referenceGroup: shelf, direction: 'within' },
    });
    const rebalance = installEditorColumnWidthRebalance(api);
    const dockBefore = fileTree.api.width;
    const sessionBefore = session.api.width;
    const shelfHeight = shelf.api.height;
    const row = visibleEditors(api).filter((group) => group.id !== shelf.id);
    const sumBefore = row.reduce((sum, group) => sum + group.api.width, 0);

    api.removePanel(api.getPanel('b2')!);
    api.removePanel(api.getPanel('b3')!);

    const remaining = visibleEditors(api).filter(
      (group) => group.id !== shelf.id
    );
    expect(remaining).toHaveLength(2);
    expectNear(fileTree.api.width, dockBefore);
    expectNear(session.api.width, sessionBefore);
    expectNear(shelf.api.height, shelfHeight);
    const share = sumBefore / remaining.length;
    for (const group of remaining) {
      expectNear(group.api.width, share);
    }
    rebalance.dispose();
    api.dispose();
  });
});
