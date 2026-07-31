import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import {
  defaultSessionPanelWidth,
  layoutDockviewPreservingGroupWidths,
} from './dockviewStartupSizing';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function createApi(width: number): DockviewApi {
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

function buildWorkspaceGroups(api: DockviewApi) {
  const welcome = api.addPanel({
    id: 'welcome',
    component: 'welcome',
    title: 'Welcome',
  });
  const fileTree = api.addGroup({
    id: 'group-left',
    referencePanel: welcome,
    direction: 'left',
    constraints: { minimumWidth: 200 },
    initialWidth: Math.max(200, Math.round(api.width * 0.1)),
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
  return { fileTree, session };
}

describe('new workspace Dockview sizing', () => {
  it('applies compact defaults when the initial canvas is already wide', () => {
    const api = createApi(1600);
    const { fileTree, session } = buildWorkspaceGroups(api);

    fileTree.api.setSize({ width: 200 });
    session.api.setSize({ width: 434 });

    expect(Math.round(fileTree.api.width)).toBe(200);
    expect(Math.round(session.api.width)).toBe(434);
    api.dispose();
  });

  it('keeps the file tree at its 200px default when the initial canvas expands', () => {
    const api = createApi(860);
    const { fileTree, session } = buildWorkspaceGroups(api);
    fileTree.api.setSize({ width: 200 });
    session.api.setSize({ width: 434 });
    layoutDockviewPreservingGroupWidths(
      api,
      [fileTree, session],
      1360,
      800,
      true
    );

    expect(Math.round(fileTree.api.width)).toBe(200);
    expect(Math.round(session.api.width)).toBe(434);
    fileTree.api.setSize({ width: 280 });
    session.api.setSize({ width: 500 });

    layoutDockviewPreservingGroupWidths(
      api,
      [fileTree, session],
      1500,
      800,
      true
    );

    expect(Math.round(fileTree.api.width)).toBe(280);
    expect(Math.round(session.api.width)).toBe(500);
    api.dispose();
  });
});
