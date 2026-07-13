/**
 * Regression tests for the restore fast-path: a persisted layout that already
 * matches the arrangement must restore VERBATIM (fromJSON), because the
 * rebuild transform only approximates column widths from measurements — it
 * resets user-dragged widths when the editor area is collapsed (the A+C
 * shape), which surfaced as "dragging the A|C divider snaps back to defaults
 * after any reload".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import { serializedLayoutMatchesArrangement } from './dockviewLayoutTransform';

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
  api.layout(1360, 800, true);
  return api;
}

/** Mirror of IDELayout's buildDefaultLayout, minus store access. */
function buildDefaultLayout(api: DockviewApi) {
  const welcomePanel = api.addPanel({
    id: 'welcome',
    component: 'welcome',
    title: 'Welcome',
  });
  (welcomePanel.group as unknown as { id: string }).id = 'group-editor-1';
  const leftGroup = api.addGroup({
    id: 'group-left',
    referencePanel: welcomePanel,
    direction: 'left',
    hideHeader: true,
    initialWidth: 272,
  });
  api.addPanel({
    id: 'file-tree',
    component: 'file-tree',
    title: 'Files',
    position: { referenceGroup: leftGroup, direction: 'within' },
  });
  const rightGroup = api.addGroup({
    id: 'group-right',
    referencePanel: welcomePanel,
    direction: 'right',
    hideHeader: true,
    initialWidth: 408,
  });
  api.addPanel({
    id: 'ai-chat',
    component: 'ai-chat',
    title: 'Sessions',
    position: { referenceGroup: rightGroup, direction: 'within' },
    inactive: true,
  });
  const bottomGroup = api.addGroup({
    id: 'group-bottom',
    referencePanel: welcomePanel,
    direction: 'below',
    locked: 'no-drop-target',
    initialHeight: 240,
  });
  api.addPanel({
    id: 'terminal',
    component: 'terminal',
    title: 'Terminal',
    position: { referenceGroup: bottomGroup, direction: 'within' },
    inactive: true,
  });
  bottomGroup.api.setVisible(false);
}

function findGroupByPanel(api: DockviewApi, panelId: string) {
  return api.groups.find((group) =>
    group.panels.some((panel) => panel.id === panelId)
  )!;
}

describe('serializedLayoutMatchesArrangement', () => {
  it('matches a canonical layout, including the collapsed-editor A+C shape', () => {
    const api = createApi();
    buildDefaultLayout(api);

    expect(
      serializedLayoutMatchesArrangement(
        api.toJSON(),
        DEFAULT_LAYOUT_ARRANGEMENT
      )
    ).toBe(true);

    // Collapse B and drag the A|C divider — still canonical.
    findGroupByPanel(api, 'welcome').api.setVisible(false);
    findGroupByPanel(api, 'file-tree').api.setSize({ width: 480 });
    expect(
      serializedLayoutMatchesArrangement(
        api.toJSON(),
        DEFAULT_LAYOUT_ARRANGEMENT
      )
    ).toBe(true);
  });

  it('verbatim fromJSON of a matching layout preserves dragged widths', () => {
    const api = createApi();
    buildDefaultLayout(api);
    findGroupByPanel(api, 'welcome').api.setVisible(false);
    findGroupByPanel(api, 'file-tree').api.setSize({ width: 480 });

    const serialized = api.toJSON();
    expect(
      serializedLayoutMatchesArrangement(serialized, DEFAULT_LAYOUT_ARRANGEMENT)
    ).toBe(true);

    const restored = createApi();
    restored.fromJSON(serialized);
    expect(Math.round(findGroupByPanel(restored, 'file-tree').api.width)).toBe(
      480
    );
    expect(findGroupByPanel(restored, 'welcome').api.isVisible).toBe(false);
  });

  it('rejects a layout without a session group (legacy migration path)', () => {
    const api = createApi();
    buildDefaultLayout(api);
    const sessionGroup = findGroupByPanel(api, 'ai-chat');
    api.removeGroup(sessionGroup);

    expect(
      serializedLayoutMatchesArrangement(
        api.toJSON(),
        DEFAULT_LAYOUT_ARRANGEMENT
      )
    ).toBe(false);
  });

  it('rejects a layout persisted under a different arrangement', () => {
    const api = createApi();
    buildDefaultLayout(api);

    expect(
      serializedLayoutMatchesArrangement(api.toJSON(), {
        left: 'session',
        center: 'workspace',
        right: 'dock',
        bottom: 'terminal',
      })
    ).toBe(false);
  });
});
