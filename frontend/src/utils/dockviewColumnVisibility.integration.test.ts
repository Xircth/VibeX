import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import {
  DEFAULT_LAYOUT_ARRANGEMENT,
  type LayoutArrangement,
} from '@/lib/layoutArrangement';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import {
  groupForZone,
  setColumnVisible,
  setColumnsVisible,
} from './dockviewEditorGroup';
import {
  defaultSessionPanelWidth,
  settleDockviewGroupWidths,
} from './dockviewStartupSizing';
import { arrangeSerializedLayout } from './dockviewLayoutTransform';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

const WIDTH_TOLERANCE = 24;

function createApi(width = 1600): DockviewApi {
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

function buildWorkspace(api: DockviewApi) {
  const welcome = api.addPanel({
    id: 'welcome',
    component: 'welcome',
    title: 'Welcome',
  });
  (welcome.group as { id: string }).id = 'group-editor-1';
  syncDockviewGroupRegistry(api);

  const fileTree = api.addGroup({
    id: 'group-left',
    referencePanel: welcome,
    direction: 'left',
    constraints: { minimumWidth: 200 },
    initialWidth: 200,
  });
  api.addPanel({
    id: 'file-tree',
    component: 'file-tree',
    title: 'Files',
    position: { referenceGroup: fileTree, direction: 'within' },
  });

  const session = api.addGroup({
    id: 'group-right',
    referencePanel: welcome,
    direction: 'right',
    constraints: { minimumWidth: 400 },
    initialWidth: defaultSessionPanelWidth(api.width, 400),
  });
  api.addPanel({
    id: 'ai-chat',
    component: 'ai-chat',
    title: 'Sessions',
    position: { referenceGroup: session, direction: 'within' },
  });

  const terminal = api.addGroup({
    id: 'group-bottom',
    referencePanel: welcome,
    direction: 'below',
    locked: 'no-drop-target',
    initialHeight: 200,
  });
  api.addPanel({
    id: 'terminal',
    component: 'terminal',
    title: 'Terminal',
    position: { referenceGroup: terminal, direction: 'within' },
    inactive: true,
  });
  terminal.api.setVisible(false);

  settleDockviewGroupWidths([
    { group: fileTree, width: 200 },
    { group: session, width: 434 },
  ]);

  return {
    welcome: welcome.group,
    fileTree,
    session,
    terminal,
  };
}

function expectWidthNear(actual: number, expected: number) {
  expect(
    Math.abs(Math.round(actual) - Math.round(expected))
  ).toBeLessThanOrEqual(WIDTH_TOLERANCE);
}

describe('slot column visibility leftover width', () => {
  it('gives leftover width to the center when hiding the left column', () => {
    const api = createApi();
    const { welcome, fileTree, session } = buildWorkspace(api);
    const leftBefore = fileTree.api.width;
    const centerBefore = welcome.api.width;
    const rightBefore = session.api.width;

    setColumnVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, fileTree, false);

    expect(fileTree.api.isVisible).toBe(false);
    expectWidthNear(session.api.width, rightBefore);
    expect(welcome.api.width).toBeGreaterThan(
      centerBefore + leftBefore - WIDTH_TOLERANCE
    );
    api.dispose();
  });

  it('takes the restored left width back from the center, not the right', () => {
    const api = createApi();
    const { welcome, fileTree, session } = buildWorkspace(api);
    const leftBefore = fileTree.api.width;
    const centerBefore = welcome.api.width;
    const rightBefore = session.api.width;

    setColumnVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, fileTree, false);
    setColumnVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, fileTree, true);

    expect(fileTree.api.isVisible).toBe(true);
    expectWidthNear(fileTree.api.width, leftBefore);
    expectWidthNear(session.api.width, rightBefore);
    expectWidthNear(welcome.api.width, centerBefore);
    api.dispose();
  });

  it('gives leftover width to the center when hiding the right column', () => {
    const api = createApi();
    const { welcome, fileTree, session } = buildWorkspace(api);
    const rightBefore = session.api.width;
    const centerBefore = welcome.api.width;
    const leftBefore = fileTree.api.width;

    setColumnVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, session, false);

    expect(session.api.isVisible).toBe(false);
    expectWidthNear(fileTree.api.width, leftBefore);
    expect(welcome.api.width).toBeGreaterThan(
      centerBefore + rightBefore - WIDTH_TOLERANCE
    );
    api.dispose();
  });

  it('gives leftover width to the right when hiding the center column', () => {
    const api = createApi();
    const { welcome, fileTree, session } = buildWorkspace(api);
    const centerBefore = welcome.api.width;
    const leftBefore = fileTree.api.width;
    const rightBefore = session.api.width;

    setColumnVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, welcome, false);

    expect(welcome.api.isVisible).toBe(false);
    expectWidthNear(fileTree.api.width, leftBefore);
    expect(session.api.width).toBeGreaterThan(
      rightBefore + centerBefore - WIDTH_TOLERANCE
    );
    api.dispose();
  });

  const swappedWorkspaceAndSession: LayoutArrangement = {
    left: 'dock',
    center: 'session',
    right: 'workspace',
    bottom: 'terminal',
  };

  function buildSwappedWorkspace(api: DockviewApi) {
    buildWorkspace(api);
    api.fromJSON(
      arrangeSerializedLayout(api.toJSON(), swappedWorkspaceAndSession)
    );
    syncDockviewGroupRegistry(api);
    const left = groupForZone(api, swappedWorkspaceAndSession.left);
    const center = groupForZone(api, swappedWorkspaceAndSession.center);
    const right = groupForZone(api, swappedWorkspaceAndSession.right);
    if (!left || !center || !right) {
      throw new Error('swapped workspace is missing a column group');
    }
    settleDockviewGroupWidths([
      { group: left, width: 200 },
      { group: right, width: Math.max(320, right.api.width) },
    ]);
    return { left, center, right };
  }

  it('still gives left leftover to center after swapping workspace and session', () => {
    const api = createApi();
    const { left, center, right } = buildSwappedWorkspace(api);
    const leftBefore = left.api.width;
    const centerBefore = center.api.width;
    const rightBefore = right.api.width;

    setColumnVisible(api, swappedWorkspaceAndSession, left, false);

    expect(left.api.isVisible).toBe(false);
    expectWidthNear(right.api.width, rightBefore);
    expect(center.api.width).toBeGreaterThan(
      centerBefore + leftBefore - WIDTH_TOLERANCE
    );
    api.dispose();
  });

  it('gives right leftover to center after swapping workspace and session', () => {
    const api = createApi();
    const { left, center, right } = buildSwappedWorkspace(api);
    const leftBefore = left.api.width;
    const centerBefore = center.api.width;
    const rightBefore = right.api.width;

    setColumnVisible(api, swappedWorkspaceAndSession, right, false);

    expect(right.api.isVisible).toBe(false);
    expectWidthNear(left.api.width, leftBefore);
    expect(center.api.width).toBeGreaterThan(
      centerBefore + rightBefore - WIDTH_TOLERANCE
    );
    api.dispose();
  });

  it('gives center leftover to the right after swapping workspace and session', () => {
    const api = createApi();
    const { left, center, right } = buildSwappedWorkspace(api);
    const leftBefore = left.api.width;
    const centerBefore = center.api.width;
    const rightBefore = right.api.width;

    setColumnVisible(api, swappedWorkspaceAndSession, center, false);

    expect(center.api.isVisible).toBe(false);
    expectWidthNear(left.api.width, leftBefore);
    expect(right.api.width).toBeGreaterThan(
      rightBefore + centerBefore - WIDTH_TOLERANCE
    );
    api.dispose();
  });

  it('gives leftover to the right when hiding several non-session columns at once', () => {
    const api = createApi();
    const { welcome, fileTree, session, terminal } = buildWorkspace(api);
    terminal.api.setVisible(true);
    const rightBefore = session.api.width;

    setColumnsVisible(api, DEFAULT_LAYOUT_ARRANGEMENT, [
      { group: fileTree, visible: false },
      { group: terminal, visible: false },
      { group: welcome, visible: false },
    ]);

    expect(session.api.isVisible).toBe(true);
    expect(fileTree.api.isVisible).toBe(false);
    expect(welcome.api.isVisible).toBe(false);
    expect(session.api.width).toBeGreaterThan(rightBefore + 400);
    api.dispose();
  });
});
