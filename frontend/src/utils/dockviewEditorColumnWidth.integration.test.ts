import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import { isEditorGroup, isSessionGroup, listSessionGroups } from './dockviewGroupPolicy';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import {
  installEditorColumnWidthRebalance,
  setSessionDockVisible,
} from './dockviewEditorGroup';
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
    disableAutoResizing: true,
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  if (width > 0) {
    api.layout(width, 800, true);
  }
  return api;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
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
  session.element?.setAttribute('data-session-dock', 'true');
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

function visibleZoneBGroups(api: DockviewApi) {
  return api.groups.filter(
    (group) =>
      (isEditorGroup(group) || isSessionGroup(group)) && group.api.isVisible
  );
}

function expectNear(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(8);
}

describe('editor column close widths', () => {
  it('shares closed B-column width across the remaining B columns without changing Zone A', () => {
    const api = createApi();
    const { fileTree } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    const dockBefore = fileTree.api.width;
    const zoneBSumBefore = visibleZoneBGroups(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    api.removePanel(api.getPanel('b2')!);
    api.removePanel(api.getPanel('b4')!);

    const remainingEditors = visibleEditors(api);
    expect(remainingEditors).toHaveLength(2);
    expectNear(fileTree.api.width, dockBefore);
    const zoneBSumAfter = visibleZoneBGroups(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );
    expectNear(zoneBSumAfter, zoneBSumBefore);
    rebalance.dispose();
    api.dispose();
  });

  it('gives closed editor column width to remaining Zone B columns and never Zone A', () => {
    const api = createApi();
    const { fileTree } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    const dockBefore = fileTree.api.width;
    const zoneBSumBefore = visibleZoneBGroups(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    api.removePanel(api.getPanel('b2')!);
    api.removePanel(api.getPanel('b3')!);
    api.removePanel(api.getPanel('b4')!);

    const remainingEditors = visibleEditors(api);
    expect(remainingEditors).toHaveLength(1);
    expectNear(fileTree.api.width, dockBefore);
    const zoneBSumAfter = visibleZoneBGroups(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );
    expectNear(zoneBSumAfter, zoneBSumBefore);
    rebalance.dispose();
    api.dispose();
  });

  it('lets the session tab bar absorb 100% of closed editor width when the last editor column closes', () => {
    const api = createApi();
    const { fileTree, session } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    const dockBefore = fileTree.api.width;
    const sessionBefore = session.api.width;
    const editorWidth = visibleEditors(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    for (const panelId of ['b1', 'b2', 'b3', 'b4']) {
      const panel = api.getPanel(panelId);
      if (panel) api.removePanel(panel);
    }

    expect(visibleEditors(api)).toHaveLength(0);
    expectNear(fileTree.api.width, dockBefore);
    expectNear(session.api.width, sessionBefore + editorWidth);
    rebalance.dispose();
    api.dispose();
  });

  it('distributes closed session tab-bar width to remaining Zone B tab bars even when Dockview mounts with 0x0 disableAutoResizing', async () => {
    const api = createApi(0);
    const rebalance = installEditorColumnWidthRebalance(api);

    const editorPanel = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    (editorPanel.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: editorPanel,
      direction: 'left',
      initialWidth: 260,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'session-list',
      component: 'session-list',
      title: 'Sessions',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const sessionGroup = api.addGroup({
      id: 'group-right',
      referencePanel: editorPanel,
      direction: 'right',
      initialWidth: 500,
    });
    sessionGroup.element?.setAttribute('data-session-dock', 'true');
    const sessionPanel = api.addPanel({
      id: 'session:1',
      component: 'session-chat',
      title: 'Session 1',
      position: { referenceGroup: sessionGroup, direction: 'within' },
    });

    api.layout(1800, 800, true);
    settleDockviewGroupWidths([
      { group: leftNav, width: 260 },
      { group: sessionGroup, width: 500 },
    ]);
    await flushMicrotasks();

    const dockBefore = leftNav.api.width;
    const editorBefore = editorPanel.group.api.width;
    const sessionBefore = sessionGroup.api.width;

    api.removePanel(sessionPanel);

    expectNear(leftNav.api.width, dockBefore);
    expectNear(editorPanel.group.api.width, editorBefore + sessionBefore);
    rebalance.dispose();
    api.dispose();
  });

  it('locks both left and right Zone A shell columns and rebalances across surviving session and editor tab bars when group IDs normalize', async () => {
    const api = createApi(1800);
    const rebalance = installEditorColumnWidthRebalance(api);
    const removeGroupNormalize = api.onDidRemoveGroup(() => {
      const sessions = listSessionGroups(api.groups);
      if (sessions[0]) {
        (sessions[0] as { id: string }).id = 'group-right';
      }
      syncDockviewGroupRegistry(api);
    });

    const editorPanel = api.addPanel({
      id: 'file:index.ts',
      component: 'preview',
      title: 'index.ts',
    });
    (editorPanel.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: editorPanel,
      direction: 'left',
      initialWidth: 240,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'session-list',
      component: 'session-list',
      title: 'Sessions',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const session1 = api.addGroup({
      id: 'group-right',
      referencePanel: editorPanel,
      direction: 'right',
      initialWidth: 420,
    });
    session1.element?.setAttribute('data-session-dock', 'true');
    const s1Panel = api.addPanel({
      id: 'session:1',
      component: 'session-chat',
      title: 'S1',
      position: { referenceGroup: session1, direction: 'within' },
    });

    const session2 = api.addGroup({
      id: 'group-right-1',
      referencePanel: s1Panel,
      direction: 'right',
      initialWidth: 420,
    });
    session2.element?.setAttribute('data-session-dock', 'true');
    const s2Panel = api.addPanel({
      id: 'session:2',
      component: 'session-chat',
      title: 'S2',
      position: { referenceGroup: session2, direction: 'within' },
    });

    const rightNav = api.addGroup({
      id: 'group-left-1',
      referencePanel: s2Panel,
      direction: 'right',
      initialWidth: 260,
    });
    rightNav.element?.setAttribute('data-left-dock', 'true');
    rightNav.element?.setAttribute('data-shell-nav-side', 'right');
    api.addPanel({
      id: 'git-panel',
      component: 'git-panel',
      title: 'Git',
      position: { referenceGroup: rightNav, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: leftNav, width: 240 },
      { group: editorPanel.group, width: 460 },
      { group: session1, width: 420 },
      { group: session2, width: 420 },
      { group: rightNav, width: 260 },
    ]);
    await flushMicrotasks();

    const leftBefore = leftNav.api.width;
    const rightBefore = rightNav.api.width;
    const zoneBSumBefore =
      editorPanel.group.api.width + session1.api.width + session2.api.width;

    // Close primary group-right; session2 is normalized to group-right
    api.removePanel(s1Panel);

    expectNear(leftNav.api.width, leftBefore);
    expectNear(rightNav.api.width, rightBefore);
    expectNear(
      editorPanel.group.api.width + session2.api.width,
      zoneBSumBefore
    );

    removeGroupNormalize.dispose();
    rebalance.dispose();
    api.dispose();
  });

  it('transfers hidden session column width to Zone B editor when setSessionDockVisible hides the empty session group', async () => {
    const api = createApi(1800);
    const { fileTree, session } = buildColumns(api);
    const rebalance = installEditorColumnWidthRebalance(api);
    await flushMicrotasks();

    const dockBefore = fileTree.api.width;
    const zoneBSumBefore = visibleZoneBGroups(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    setSessionDockVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, false);

    expect(session.api.isVisible).toBe(false);
    expectNear(fileTree.api.width, dockBefore);
    const remainingSum = visibleEditors(api).reduce(
      (sum, group) => sum + group.api.width,
      0
    );
    expectNear(remainingSum, zoneBSumBefore);
    rebalance.dispose();
    api.dispose();
  });

  it('gives closed session width to an editor column stacked above a terminal shelf without widening Zone A', async () => {
    const api = createApi(1800);
    const rebalance = installEditorColumnWidthRebalance(api);

    const editorPanel = api.addPanel({
      id: 'b1',
      component: 'preview',
      title: 'B1',
    });
    (editorPanel.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const fileTree = api.addGroup({
      id: 'group-left',
      referencePanel: editorPanel,
      direction: 'left',
      initialWidth: 230,
    });
    fileTree.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      title: 'Files',
      position: { referenceGroup: fileTree, direction: 'within' },
    });

    const session = api.addGroup({
      id: 'group-right',
      referencePanel: editorPanel,
      direction: 'right',
      initialWidth: 520,
    });
    session.element?.setAttribute('data-session-dock', 'true');
    const sessionPanel = api.addPanel({
      id: 'session:1',
      component: 'session-chat',
      title: 'Session 1',
      position: { referenceGroup: session, direction: 'within' },
    });

    const shelf = addGroupBelowEditorGroups(api, [editorPanel.group], {
      id: 'group-editor-2',
      height: terminalShelfHeight(api.height),
    });
    api.addPanel({
      id: 'terminal:1',
      component: 'terminal',
      title: 'Terminal',
      position: { referenceGroup: shelf, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: fileTree, width: 230 },
      { group: session, width: 520 },
    ]);
    await flushMicrotasks();

    const dockBefore = fileTree.api.width;
    const editorBefore = editorPanel.group.api.width;
    const sessionBefore = session.api.width;
    const shelfHeight = shelf.api.height;

    api.removePanel(sessionPanel);

    expectNear(fileTree.api.width, dockBefore);
    expectNear(editorPanel.group.api.width, editorBefore + sessionBefore);
    expectNear(shelf.api.height, shelfHeight);
    rebalance.dispose();
    api.dispose();
  });

  it('keeps the shelf height and Zone A width when an editor column closes', () => {
    const api = createApi();
    const { fileTree } = buildColumns(api);
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
    const shelfHeight = shelf.api.height;
    const zoneBBefore = visibleZoneBGroups(api)
      .filter((group) => group.id !== shelf.id)
      .reduce((sum, group) => sum + group.api.width, 0);

    api.removePanel(api.getPanel('b2')!);
    api.removePanel(api.getPanel('b3')!);

    const remaining = visibleEditors(api).filter(
      (group) => group.id !== shelf.id
    );
    expect(remaining).toHaveLength(2);
    expectNear(fileTree.api.width, dockBefore);
    expectNear(shelf.api.height, shelfHeight);
    const zoneBAfter = visibleZoneBGroups(api)
      .filter((group) => group.id !== shelf.id)
      .reduce((sum, group) => sum + group.api.width, 0);
    expectNear(zoneBAfter, zoneBBefore);
    rebalance.dispose();
    api.dispose();
  });
});
