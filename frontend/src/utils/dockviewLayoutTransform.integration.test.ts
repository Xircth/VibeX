/**
 * Integration test: run the arrangement transform against a real
 * dockview-core instance so the serialized shape we synthesize is validated
 * by the actual deserializer, not just by structural assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDockview, type DockviewApi } from 'dockview-core';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import { arrangeSerializedLayout } from './dockviewLayoutTransform';
import { syncDockviewGroupRegistry } from './dockviewHelpers';

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
  api.layout(1280, 800, true);
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
    initialWidth: 220,
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
    initialWidth: 520,
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
    initialHeight: 200,
  });
  api.addPanel({
    id: 'terminal',
    component: 'terminal',
    title: 'Terminal',
    position: { referenceGroup: bottomGroup, direction: 'within' },
    inactive: true,
  });

  // IDELayout's normalizeGroupIds runs this after renaming group ids.
  syncDockviewGroupRegistry(api as unknown as Parameters<
    typeof syncDockviewGroupRegistry
  >[0]);

  return api;
}

type AnyNode = {
  type: 'leaf' | 'branch';
  data: AnyNode[] | { views: string[]; id: string };
  size?: number;
};

function rootColumns(api: DockviewApi): AnyNode[] {
  return (api.toJSON().grid.root as AnyNode).data as AnyNode[];
}

describe('arrangeSerializedLayout against dockview-core', () => {
  it('round-trips the default arrangement through fromJSON', () => {
    const api = buildDefaultLayout(createApi());
    const transformed = arrangeSerializedLayout(
      api.toJSON(),
      DEFAULT_LAYOUT_ARRANGEMENT
    );

    expect(() => api.fromJSON(transformed)).not.toThrow();
    expect(api.groups).toHaveLength(4);
    expect(api.getGroup('group-left')).toBeDefined();
    expect(api.getGroup('group-right')).toBeDefined();
    expect(api.getGroup('group-bottom')).toBeDefined();
  });

  it('applies a B/C swap and preserves widths', () => {
    const api = buildDefaultLayout(createApi());
    const before = api.toJSON();
    // Width of the center compound column (workspace + terminal) before the
    // swap; the workspace zone must keep it after moving to the right slot.
    const centerWidthBefore = ((before.grid.root as AnyNode).data as AnyNode[])
      .find((column) => column.type === 'branch')?.size;
    expect(centerWidthBefore).toBeGreaterThan(0);

    const transformed = arrangeSerializedLayout(before, {
      ...DEFAULT_LAYOUT_ARRANGEMENT,
      center: 'session',
      right: 'workspace',
    });

    expect(() => api.fromJSON(transformed)).not.toThrow();
    expect(api.groups).toHaveLength(4);

    const workspaceGroup = api.groups.find((group) =>
      group.panels.some((panel) => panel.id === 'welcome')
    );
    // Widths swap 1:1; allow a couple of pixels for dockview's proportional
    // normalization when measured column sums drift from the grid width.
    expect(
      Math.abs((workspaceGroup?.api.width ?? 0) - (centerWidthBefore ?? 0))
    ).toBeLessThanOrEqual(3);

    // Structural order after the swap: dock column, session compound column
    // (with the terminal strip below), workspace column.
    const columns = rootColumns(api);
    expect((columns[0].data as { id: string }).id).toBe('group-left');
    expect(columns[1].type).toBe('branch');
    const centerRows = columns[1].data as AnyNode[];
    expect((centerRows[0].data as { views: string[] }).views).toEqual([
      'ai-chat',
    ]);
    expect((centerRows[1].data as { views: string[] }).views).toEqual([
      'terminal',
    ]);
    expect((columns[2].data as { views: string[] }).views).toEqual([
      'welcome',
    ]);
  });

  it('migrates a layout that has no session group yet', () => {
    const api = createApi();
    const welcomePanel = api.addPanel({
      id: 'welcome',
      component: 'welcome',
      title: 'Welcome',
    });
    (welcomePanel.group as unknown as { id: string }).id = 'group-editor-1';
    api.addGroup({
      id: 'group-left',
      referencePanel: welcomePanel,
      direction: 'left',
      initialWidth: 220,
    });
    syncDockviewGroupRegistry(api as unknown as Parameters<
      typeof syncDockviewGroupRegistry
    >[0]);

    const transformed = arrangeSerializedLayout(
      api.toJSON(),
      DEFAULT_LAYOUT_ARRANGEMENT,
      { fallbackSizes: { session: { width: 500 } }, sessionVisible: true }
    );

    expect(() => api.fromJSON(transformed)).not.toThrow();
    const sessionGroup = api.getGroup('group-right');
    expect(sessionGroup).toBeDefined();
    expect(sessionGroup?.panels.map((panel) => panel.id)).toEqual(['ai-chat']);
  });

  it('supports every zone permutation without throwing', () => {
    const zones = ['dock', 'workspace', 'session', 'terminal'] as const;
    const permutations: (typeof zones)[number][][] = [];
    const permute = (
      rest: (typeof zones)[number][],
      acc: (typeof zones)[number][]
    ) => {
      if (rest.length === 0) {
        permutations.push(acc);
        return;
      }
      for (const zone of rest) {
        permute(
          rest.filter((candidate) => candidate !== zone),
          [...acc, zone]
        );
      }
    };
    permute([...zones], []);
    expect(permutations).toHaveLength(24);

    for (const [left, center, right, bottom] of permutations) {
      const api = buildDefaultLayout(createApi());
      const transformed = arrangeSerializedLayout(api.toJSON(), {
        left,
        center,
        right,
        bottom,
      });

      expect(() => api.fromJSON(transformed)).not.toThrow();
      expect(api.groups).toHaveLength(4);
      api.dispose();
    }
  });
});
