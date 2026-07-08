import { describe, it, expect } from 'vitest';
import { Orientation, type SerializedDockview } from 'dockview';
import { DEFAULT_LAYOUT_ARRANGEMENT } from '@/lib/layoutArrangement';
import { arrangeSerializedLayout } from './dockviewLayoutTransform';

type AnyNode = {
  type: 'leaf' | 'branch';
  data: AnyNode[] | { views: string[]; activeView?: string; id: string };
  size?: number;
  visible?: boolean;
};

function leaf(
  id: string,
  views: string[],
  size?: number,
  visible?: boolean
): AnyNode {
  return {
    type: 'leaf',
    data: { views, activeView: views[0], id },
    ...(size !== undefined ? { size } : {}),
    ...(visible !== undefined ? { visible } : {}),
  };
}

function panelsFor(views: string[]): SerializedDockview['panels'] {
  return Object.fromEntries(
    views.map((view) => [
      view,
      { id: view, contentComponent: view, title: view },
    ])
  );
}

function makeLayout(root: AnyNode, views: string[]): SerializedDockview {
  return {
    grid: {
      root: root as SerializedDockview['grid']['root'],
      width: 1280,
      height: 800,
      orientation: Orientation.HORIZONTAL,
    },
    panels: panelsFor(views),
    activeGroup: 'group-editor-1',
  };
}

function defaultShapedLayout(): SerializedDockview {
  return makeLayout(
    {
      type: 'branch',
      data: [
        leaf('group-left', ['file-tree'], 220),
        {
          type: 'branch',
          data: [
            leaf('group-editor-1', ['welcome'], 600),
            leaf('group-bottom', ['terminal'], 200, false),
          ],
          size: 540,
        },
        leaf('group-right', ['ai-chat'], 520),
      ],
    },
    ['file-tree', 'welcome', 'terminal', 'ai-chat']
  );
}

function rootChildren(layout: SerializedDockview): AnyNode[] {
  return (layout.grid.root as AnyNode).data as AnyNode[];
}

function leafId(node: AnyNode): string {
  return (node.data as { id: string }).id;
}

describe('arrangeSerializedLayout', () => {
  it('keeps the canonical default shape stable', () => {
    const result = arrangeSerializedLayout(
      defaultShapedLayout(),
      DEFAULT_LAYOUT_ARRANGEMENT
    );

    const columns = rootChildren(result);
    expect(columns).toHaveLength(3);
    expect(leafId(columns[0])).toBe('group-left');
    expect(columns[0].size).toBe(220);
    expect(columns[1].type).toBe('branch');
    const centerRows = columns[1].data as AnyNode[];
    expect(leafId(centerRows[0])).toBe('group-editor-1');
    expect(leafId(centerRows[1])).toBe('group-bottom');
    expect(centerRows[1].visible).toBe(false);
    expect(leafId(columns[2])).toBe('group-right');
    expect(columns[2].size).toBe(520);
    expect(result.activeGroup).toBe('group-editor-1');
  });

  it('swapping center and right keeps each zone size (B stays as wide on the right)', () => {
    const result = arrangeSerializedLayout(defaultShapedLayout(), {
      ...DEFAULT_LAYOUT_ARRANGEMENT,
      center: 'session',
      right: 'workspace',
    });

    const columns = rootChildren(result);
    expect(leafId(columns[0])).toBe('group-left');

    // Session moved to the center compound column and absorbs the remainder,
    // which equals its previous width because swaps conserve total width.
    const centerRows = columns[1].data as AnyNode[];
    expect(leafId(centerRows[0])).toBe('group-right');
    expect(leafId(centerRows[1])).toBe('group-bottom');
    expect(columns[1].size).toBe(1280 - 220 - 540);

    // Workspace keeps the width it had while in the center.
    expect(leafId(columns[2])).toBe('group-editor-1');
    expect(columns[2].size).toBe(540);
  });

  it('moves the terminal into a column and pulls another zone into the bottom strip', () => {
    const result = arrangeSerializedLayout(
      defaultShapedLayout(),
      {
        left: 'dock',
        center: 'workspace',
        right: 'terminal',
        bottom: 'session',
      },
      { fallbackSizes: { terminal: { width: 360 }, session: { height: 260 } } }
    );

    const columns = rootChildren(result);
    expect(leafId(columns[0])).toBe('group-left');

    const centerRows = columns[1].data as AnyNode[];
    expect(leafId(centerRows[0])).toBe('group-editor-1');
    expect(leafId(centerRows[1])).toBe('group-right');
    expect(centerRows[1].size).toBe(260);

    expect(leafId(columns[2])).toBe('group-bottom');
    expect(columns[2].size).toBe(360);
  });

  it('synthesizes the session group for legacy layouts without one', () => {
    const legacy = makeLayout(
      {
        type: 'branch',
        data: [
          leaf('group-left', ['file-tree'], 220),
          {
            type: 'branch',
            data: [
              leaf('group-editor-1', ['welcome'], 600),
              leaf('group-bottom', ['terminal'], 200, false),
            ],
            size: 1060,
          },
        ],
      },
      ['file-tree', 'welcome', 'terminal']
    );

    const result = arrangeSerializedLayout(legacy, DEFAULT_LAYOUT_ARRANGEMENT, {
      fallbackSizes: { session: { width: 500 } },
      sessionVisible: false,
    });

    const columns = rootChildren(result);
    expect(columns).toHaveLength(3);
    const sessionColumn = columns[2];
    expect(leafId(sessionColumn)).toBe('group-right');
    expect(sessionColumn.size).toBe(500);
    expect(sessionColumn.visible).toBe(false);
    expect(
      (sessionColumn.data as { views: string[] }).views
    ).toEqual(['ai-chat']);
    expect(result.panels['ai-chat']).toBeDefined();
  });

  it('flattens multi-group workspace splits when the zone changes slots', () => {
    const layout = makeLayout(
      {
        type: 'branch',
        data: [
          leaf('group-left', ['file-tree'], 220),
          {
            type: 'branch',
            data: [
              {
                type: 'branch',
                data: [
                  leaf('group-editor-1', ['welcome'], 300),
                  leaf('group-editor-2', ['logs'], 300),
                ],
                size: 600,
              },
              leaf('group-bottom', ['terminal'], 200, false),
            ],
            size: 540,
          },
          leaf('group-right', ['ai-chat'], 520),
        ],
      },
      ['file-tree', 'welcome', 'logs', 'terminal', 'ai-chat']
    );

    const result = arrangeSerializedLayout(layout, {
      ...DEFAULT_LAYOUT_ARRANGEMENT,
      left: 'workspace',
      center: 'dock',
    });

    const columns = rootChildren(result);
    const workspaceColumn = columns[0];
    expect(workspaceColumn.type).toBe('branch');
    const workspaceLeaves = workspaceColumn.data as AnyNode[];
    expect(workspaceLeaves.map(leafId)).toEqual([
      'group-editor-1',
      'group-editor-2',
    ]);
    // Workspace keeps the width it had while in the center column.
    expect(workspaceColumn.size).toBe(540);
  });

  it('is stable when applied twice with the same arrangement', () => {
    const arrangement = {
      ...DEFAULT_LAYOUT_ARRANGEMENT,
      center: 'session' as const,
      right: 'workspace' as const,
    };
    const once = arrangeSerializedLayout(defaultShapedLayout(), arrangement);
    const twice = arrangeSerializedLayout(once, arrangement);

    expect(twice.grid.root).toEqual(once.grid.root);
  });

  it('drops a stale activeGroup reference', () => {
    const layout = defaultShapedLayout();
    layout.activeGroup = 'group-gone';

    const result = arrangeSerializedLayout(layout, DEFAULT_LAYOUT_ARRANGEMENT);
    expect(result.activeGroup).toBeUndefined();
  });
});
