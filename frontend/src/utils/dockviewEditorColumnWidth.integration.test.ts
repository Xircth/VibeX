import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import {
  attachDockviewWorkspaceListeners,
  registerDockviewOverlayDropGuard,
  type DropTargetZone,
} from '@/components/layout/ideLayoutDockviewListeners';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import {
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
  listSessionGroups,
} from './dockviewGroupPolicy';
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

interface DockviewHost {
  moveGroupOrPanel: (options: {
    from: { groupId: string; panelId?: string };
    to: {
      group: ReturnType<DockviewApi['getGroup']>;
      position: 'left' | 'right' | 'top' | 'bottom' | 'center';
    };
  }) => void;
  _onWillDrop?: {
    fire: (event: {
      group: ReturnType<DockviewApi['getGroup']>;
      position: 'left' | 'right' | 'top' | 'bottom' | 'center';
    }) => void;
  };
  _onWillShowOverlay?: {
    fire: (event: {
      kind: 'content';
      group: ReturnType<DockviewApi['getGroup']>;
      position: 'left' | 'right' | 'top' | 'bottom' | 'center';
      panel?: ReturnType<DockviewApi['getPanel']>;
      getData: () => { groupId: string; panelId: string };
      preventDefault: () => void;
    }) => void;
  };
}

function dockviewHost(api: DockviewApi): DockviewHost {
  return (api as unknown as { component: DockviewHost }).component;
}

describe('tab split column widths', () => {
  it('preserves Zone A width when drag-splitting an editor tab right in a 2-column A/B layout (hidden Zone C)', async () => {
    const api = createApi(1600);
    const rebalance = installEditorColumnWidthRebalance(api);

    const welcome = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    const editorGroup = welcome.group;
    (editorGroup as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    api.addPanel({
      id: 'ai-chat:master',
      component: 'ai-chat',
      title: 'Master',
      position: { referenceGroup: editorGroup, direction: 'within' },
    });
    api.addPanel({
      id: 'ai-chat:new-1',
      component: 'ai-chat',
      title: 'New Session',
      position: { referenceGroup: editorGroup, direction: 'within' },
    });

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: welcome,
      direction: 'left',
      initialWidth: 253,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'session-list',
      component: 'session-list',
      title: 'Sessions',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const hiddenRight = api.addGroup({
      id: 'group-right',
      referencePanel: welcome,
      direction: 'right',
      initialWidth: 434,
    });
    hiddenRight.element?.setAttribute('data-session-dock', 'true');
    hiddenRight.api.setVisible(false);

    settleDockviewGroupWidths([
      { group: leftNav, width: 253 },
      { group: editorGroup, width: 1347 },
    ]);
    await flushMicrotasks();

    const leftBefore = leftNav.api.width;
    const editorBefore = editorGroup.api.width;
    const host = dockviewHost(api);

    host._onWillDrop?.fire({ group: editorGroup, position: 'right' });
    host.moveGroupOrPanel({
      from: { groupId: editorGroup.id, panelId: 'ai-chat:master' },
      to: { group: editorGroup, position: 'right' },
    });

    const masterAfter = api.getPanel('ai-chat:master')!;
    const splitGroup = masterAfter.group;
    expect(splitGroup).not.toBe(editorGroup);
    expectNear(leftNav.api.width, leftBefore);
    expectNear(editorGroup.api.width, Math.floor(editorBefore / 2));
    expectNear(splitGroup.api.width, Math.floor(editorBefore / 2));
    expect(hiddenRight.api.isVisible).toBe(false);

    rebalance.dispose();
    api.dispose();
  });

  it('preserves Zone A, Zone C, and unrelated editor columns when splitting one of two editor columns', async () => {
    const api = createApi(1800);
    const rebalance = installEditorColumnWidthRebalance(api);

    const p1 = api.addPanel({
      id: 'file:a.ts',
      component: 'preview',
      title: 'a.ts',
    });
    const editor1 = p1.group;
    (editor1 as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: p1,
      direction: 'left',
      initialWidth: 220,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      title: 'Files',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const session = api.addGroup({
      id: 'group-right',
      referencePanel: p1,
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

    const editor2 = api.addGroup({
      id: 'group-editor-2',
      referencePanel: p1,
      direction: 'right',
    });
    const p2 = api.addPanel({
      id: 'file:b.ts',
      component: 'preview',
      title: 'b.ts',
      position: { referenceGroup: editor2, direction: 'within' },
    });
    api.addPanel({
      id: 'file:c.ts',
      component: 'preview',
      title: 'c.ts',
      position: { referenceGroup: editor2, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: leftNav, width: 220 },
      { group: editor1, width: 400 },
      { group: editor2, width: 746 },
      { group: session, width: 434 },
    ]);
    await flushMicrotasks();

    const host = dockviewHost(api);
    host._onWillDrop?.fire({ group: editor2, position: 'left' });
    host.moveGroupOrPanel({
      from: { groupId: editor2.id, panelId: p2.id },
      to: { group: editor2, position: 'left' },
    });

    const splitGroup = api.getPanel(p2.id)!.group;
    expect(splitGroup).not.toBe(editor2);
    expectNear(leftNav.api.width, 220);
    expectNear(editor1.api.width, 400);
    expectNear(session.api.width, 434);
    expectNear(editor2.api.width, 373);
    expectNear(splitGroup.api.width, 373);

    rebalance.dispose();
    api.dispose();
  });

  it('preserves Zone A width when moving a 1-tab group out of a vertical stack into a horizontal split (movingLock path)', async () => {
    const api = createApi(1600);
    const rebalance = installEditorColumnWidthRebalance(api);

    const p1 = api.addPanel({
      id: 'file:top.ts',
      component: 'preview',
      title: 'top.ts',
    });
    const topGroup = p1.group;
    (topGroup as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: p1,
      direction: 'left',
      initialWidth: 240,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      title: 'Files',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const session = api.addGroup({
      id: 'group-right',
      referencePanel: p1,
      direction: 'right',
      initialWidth: 360,
    });
    session.element?.setAttribute('data-session-dock', 'true');
    api.addPanel({
      id: 'ai-chat',
      component: 'ai-chat',
      title: 'Sessions',
      position: { referenceGroup: session, direction: 'within' },
    });

    const bottomGroup = api.addGroup({
      id: 'group-editor-2',
      referencePanel: p1,
      direction: 'below',
    });
    const p2 = api.addPanel({
      id: 'file:bottom.ts',
      component: 'preview',
      title: 'bottom.ts',
      position: { referenceGroup: bottomGroup, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: leftNav, width: 240 },
      { group: topGroup, width: 1000 },
      { group: session, width: 360 },
    ]);
    await flushMicrotasks();

    const host = dockviewHost(api);
    host._onWillDrop?.fire({ group: topGroup, position: 'right' });
    host.moveGroupOrPanel({
      from: { groupId: bottomGroup.id, panelId: p2.id },
      to: { group: topGroup, position: 'right' },
    });

    expectNear(leftNav.api.width, 240);
    expectNear(session.api.width, 360);
    expectNear(topGroup.api.width, 500);
    expectNear(api.getPanel(p2.id)!.group.api.width, 500);

    rebalance.dispose();
    api.dispose();
  });

  it('absorbs freed column width into Zone B without widening Zone A when a 1-tab column moves vertically onto another column', async () => {
    const api = createApi(1600);
    const rebalance = installEditorColumnWidthRebalance(api);

    const p1 = api.addPanel({
      id: 'file:left.ts',
      component: 'preview',
      title: 'left.ts',
    });
    const editor1 = p1.group;
    (editor1 as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: p1,
      direction: 'left',
      initialWidth: 240,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      title: 'Files',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const editor2 = api.addGroup({
      id: 'group-editor-2',
      referencePanel: p1,
      direction: 'right',
    });
    const p2 = api.addPanel({
      id: 'file:right.ts',
      component: 'preview',
      title: 'right.ts',
      position: { referenceGroup: editor2, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: leftNav, width: 240 },
      { group: editor1, width: 680 },
      { group: editor2, width: 680 },
    ]);
    await flushMicrotasks();

    const host = dockviewHost(api);
    host._onWillDrop?.fire({ group: editor1, position: 'bottom' });
    host.moveGroupOrPanel({
      from: { groupId: editor2.id, panelId: p2.id },
      to: { group: editor1, position: 'bottom' },
    });

    expectNear(leftNav.api.width, 240);
    expectNear(editor1.api.width, 1360);
    expectNear(api.getPanel(p2.id)!.group.api.width, 1360);

    rebalance.dispose();
    api.dispose();
  });

  it('preserves Zone A and Zone B editor columns when horizontally splitting a multi-tab session column', async () => {
    const api = createApi(1800);
    const rebalance = installEditorColumnWidthRebalance(api);

    const editor = api.addPanel({
      id: 'file:app.ts',
      component: 'preview',
      title: 'app.ts',
    });
    (editor.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: editor,
      direction: 'left',
      initialWidth: 240,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      title: 'Files',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    const sessionGroup = api.addGroup({
      id: 'group-right',
      referencePanel: editor,
      direction: 'right',
      initialWidth: 640,
    });
    sessionGroup.element?.setAttribute('data-session-dock', 'true');
    const s1 = api.addPanel({
      id: 'ai-chat:1',
      component: 'ai-chat',
      title: 'S1',
      position: { referenceGroup: sessionGroup, direction: 'within' },
    });
    const s2 = api.addPanel({
      id: 'ai-chat:2',
      component: 'ai-chat',
      title: 'S2',
      position: { referenceGroup: sessionGroup, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: leftNav, width: 240 },
      { group: editor.group, width: 920 },
      { group: sessionGroup, width: 640 },
    ]);
    await flushMicrotasks();

    const host = dockviewHost(api);
    host._onWillDrop?.fire({ group: sessionGroup, position: 'right' });
    host.moveGroupOrPanel({
      from: { groupId: sessionGroup.id, panelId: s2.id },
      to: { group: sessionGroup, position: 'right' },
    });

    expectNear(leftNav.api.width, 240);
    expectNear(editor.group.api.width, 920);
    expectNear(s1.group.api.width, 320);
    expectNear(s2.group.api.width, 320);

    rebalance.dispose();
    api.dispose();
  });

  it('normalizes group IDs before rebalancing inside attachDockviewWorkspaceListeners', async () => {
    const api = createApi(1600);
    const lastDropTargetZoneRef: { current: DropTargetZone } = {
      current: null,
    };
    const cleanup = attachDockviewWorkspaceListeners(api, {
      apiRef: { current: api },
      dockviewRootEl: null,
      isResettingRef: { current: false },
      isCollapsedRef: { current: false },
      lastDropTargetZoneRef,
      layoutChangeTimerRef: { current: null },
      lastSelfHealAtRef: { current: 0 },
      registerDndGuard: (dockApi) =>
        registerDockviewOverlayDropGuard(dockApi, lastDropTargetZoneRef),
      applyArrangement: vi.fn(),
      setSerializedLayout: vi.fn(),
      setRightPanelWidth: vi.fn(),
    });

    const welcome = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    const editorGroup = welcome.group;
    (editorGroup as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const masterPanel = api.addPanel({
      id: 'ai-chat:master',
      component: 'ai-chat',
      title: 'Master',
      position: { referenceGroup: editorGroup, direction: 'within' },
    });

    const leftNav = api.addGroup({
      id: 'group-left',
      referencePanel: welcome,
      direction: 'left',
      initialWidth: 253,
    });
    leftNav.element?.setAttribute('data-left-dock', 'true');
    api.addPanel({
      id: 'session-list',
      component: 'session-list',
      title: 'Sessions',
      position: { referenceGroup: leftNav, direction: 'within' },
    });

    settleDockviewGroupWidths([
      { group: leftNav, width: 253 },
      { group: editorGroup, width: 1347 },
    ]);
    await flushMicrotasks();

    const host = dockviewHost(api);
    host._onWillShowOverlay?.fire({
      kind: 'content',
      group: editorGroup,
      position: 'right',
      panel: masterPanel,
      getData: () => ({ groupId: editorGroup.id, panelId: masterPanel.id }),
      preventDefault: () => {},
    });
    host._onWillDrop?.fire({ group: editorGroup, position: 'right' });
    host.moveGroupOrPanel({
      from: { groupId: editorGroup.id, panelId: masterPanel.id },
      to: { group: editorGroup, position: 'right' },
    });

    expect(masterPanel.group.id).toBe('group-editor-2');
    expect(isEditorGroup(masterPanel.group)).toBe(true);
    expect(isLeftGroup(leftNav)).toBe(true);
    expectNear(leftNav.api.width, 253);
    expectNear(editorGroup.api.width, 673);
    expectNear(masterPanel.group.api.width, 673);

    cleanup();
    api.dispose();
  });
});
