import { beforeAll, describe, expect, it } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { syncDockviewGroupRegistry } from './dockviewHelpers';
import { isEditorGroup } from './dockviewGroupPolicy';
import {
  addGroupBelowEditorGroups,
  terminalShelfHeight,
} from './dockviewEditorSplit';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function createApi(): DockviewApi {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const api = createDockview(container, {
    createComponent: () => ({
      element: document.createElement('div'),
      init: () => {},
      dispose: () => {},
    }),
  });
  api.layout(1400, 800, true);
  return api;
}

function editorGroups(api: DockviewApi) {
  return api.groups.filter((group) => isEditorGroup(group));
}

describe('editor shelf split', () => {
  it('places a new group under side-by-side editors at about 40 percent height', () => {
    const api = createApi();
    const welcome = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    (welcome.group as { id: string }).id = 'group-editor-1';
    syncDockviewGroupRegistry(api);

    const files = api.addGroup({
      id: 'group-left',
      referencePanel: welcome,
      direction: 'left',
      initialWidth: 200,
    });
    api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      title: 'Files',
      position: { referenceGroup: files, direction: 'within' },
    });

    const session = api.addGroup({
      id: 'group-right',
      referencePanel: welcome,
      direction: 'right',
      initialWidth: 320,
    });
    api.addPanel({
      id: 'ai-chat',
      component: 'ai-chat',
      title: 'Sessions',
      position: { referenceGroup: session, direction: 'within' },
    });

    const second = api.addGroup({
      id: 'group-editor-2',
      referencePanel: welcome,
      direction: 'right',
    });
    const moved = api.addPanel({
      id: 'file:a.ts',
      component: 'preview',
      title: 'a.ts',
      position: { referenceGroup: second, direction: 'within' },
    });

    const before = editorGroups(api);
    expect(before.map((group) => group.id).sort()).toEqual([
      'group-editor-1',
      'group-editor-2',
    ]);
    const widthBefore = new Map(
      api.groups.map((group) => [group.id, group.api.width])
    );
    const editorWidthBefore = before.reduce(
      (sum, group) => sum + group.api.width,
      0
    );

    const height = terminalShelfHeight(api.height);
    const shelf = addGroupBelowEditorGroups(api, before, {
      id: 'group-editor-3',
      height,
    });

    const editors = editorGroups(api).filter((group) => group.id !== shelf.id);

    // jsdom does not layout CSS, so geometry comes from dockview's sizes.
    expect(shelf.api.width).toBeGreaterThan(editorWidthBefore * 0.85);
    expect(shelf.api.width).toBeLessThan(editorWidthBefore * 1.15);
    for (const group of editors) {
      const previous = widthBefore.get(group.id) ?? 0;
      expect(group.api.width).toBeGreaterThan(previous * 0.85);
      expect(group.api.width).toBeLessThan(previous * 1.15);
      expect(group.api.height).toBeLessThan(api.height * 0.75);
    }
    expect(files.api.height).toBeGreaterThan(api.height * 0.9);
    expect(session.api.height).toBeGreaterThan(api.height * 0.9);
    expect(
      Math.abs(files.api.width - (widthBefore.get('group-left') ?? 0))
    ).toBeLessThan(24);
    expect(
      Math.abs(session.api.width - (widthBefore.get('group-right') ?? 0))
    ).toBeLessThan(24);
    expect(shelf.api.height).toBeGreaterThan(height * 0.7);
    expect(shelf.api.height).toBeLessThan(height * 1.3);

    moved.api.moveTo({ group: welcome.group });
    expect(welcome.group.panels.some((panel) => panel.id === moved.id)).toBe(
      true
    );

    shelf.api.setSize({ height: 180 });
    expect(shelf.api.height).toBeLessThan(height * 0.8);

    api.dispose();
  });
});
