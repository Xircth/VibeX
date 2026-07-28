/**
 * Pure transformation of a serialized dockview layout into a target zone
 * arrangement (see `lib/layoutArrangement.ts`).
 *
 * The canonical grid shape produced here is always:
 *
 *   root (HORIZONTAL)
 *   ├── <left-slot zone>                       (full-height column)
 *   ├── branch (VERTICAL)                      (center column)
 *   │   ├── <center-slot zone>
 *   │   └── <bottom-slot zone>                 (strip under the center zone)
 *   └── <right-slot zone>                      (full-height column)
 *
 * Sizes travel with zones: a zone keeps its width when moved between column
 * slots, while the center slot always absorbs the remaining width. Multi-group
 * workspace splits are flattened to a single row/column of groups because
 * gridview orientation alternates per depth, so a nested subtree cannot be
 * re-parented across slots without changing its meaning.
 */
import { Orientation, type SerializedDockview } from 'dockview';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import {
  BOTTOM_PANEL_IDS,
  LEFT_PANEL_IDS,
  SESSION_PANEL_IDS,
} from '@/utils/dockviewGroupPolicy';
import {
  LAYOUT_SLOTS,
  type LayoutArrangement,
  type LayoutZone,
} from '@/lib/layoutArrangement';
import { DEFAULT_SESSION_PANEL_WIDTH } from '@/utils/dockviewStartupSizing';

interface SerializedLeaf {
  type: 'leaf';
  data: {
    views: string[];
    activeView?: string;
    id: string;
  } & Record<string, unknown>;
  size?: number;
  visible?: boolean;
}

interface SerializedBranch {
  type: 'branch';
  data: SerializedNode[];
  size?: number;
}

type SerializedNode = SerializedLeaf | SerializedBranch;

export interface ArrangeLayoutOptions {
  /** Per-zone size hints used when the current layout has no measurement. */
  fallbackSizes?: Partial<
    Record<LayoutZone, Partial<{ width: number; height: number }>>
  >;
  /** Synthesize the session group when the layout predates it (default true). */
  ensureSessionPanel?: boolean;
  /** Visibility for a synthesized session group (default true). */
  sessionVisible?: boolean;
}

const ZONE_DEFAULT_SIZES: Record<
  LayoutZone,
  { width: number; height: number }
> = {
  dock: { width: 200, height: 220 },
  workspace: { width: 560, height: 320 },
  // Used only when neither serialized geometry nor a live-grid fallback is
  // available. Reuse the shared default instead of reviving the retired
  // 620px value during legacy-layout synthesis.
  session: { width: DEFAULT_SESSION_PANEL_WIDTH, height: 320 },
  terminal: { width: 360, height: 200 },
};

const FALLBACK_GRID_WIDTH = 1280;
const FALLBACK_GRID_HEIGHT = 800;
const CENTER_MIN_HEIGHT = 160;

function isLeafNode(node: SerializedNode): node is SerializedLeaf {
  return node.type === 'leaf';
}

export function classifyLeafZone(leaf: SerializedLeaf): LayoutZone {
  const views = leaf.data.views ?? [];
  if (
    leaf.data.id === GROUP_IDS.LEFT ||
    views.some((view) => LEFT_PANEL_IDS.has(view))
  ) {
    return 'dock';
  }
  if (
    leaf.data.id === GROUP_IDS.BOTTOM ||
    views.some((view) => BOTTOM_PANEL_IDS.has(view))
  ) {
    return 'terminal';
  }
  if (
    leaf.data.id === GROUP_IDS.RIGHT ||
    views.some((view) => SESSION_PANEL_IDS.has(view))
  ) {
    return 'session';
  }
  return 'workspace';
}

function cloneLeaf(leaf: SerializedLeaf): SerializedLeaf {
  return JSON.parse(JSON.stringify(leaf)) as SerializedLeaf;
}

function collectLeaves(node: SerializedNode, out: SerializedLeaf[]): void {
  if (isLeafNode(node)) {
    out.push(node);
    return;
  }
  for (const child of node.data) {
    collectLeaves(child, out);
  }
}

function zonesInNode(node: SerializedNode): Set<LayoutZone> {
  const leaves: SerializedLeaf[] = [];
  collectLeaves(node, leaves);
  return new Set(leaves.map(classifyLeafZone));
}

interface MeasuredZoneSizes {
  widths: Partial<Record<LayoutZone, number>>;
  heights: Partial<Record<LayoutZone, number>>;
}

/**
 * Best-effort size measurement from the canonical grid shape. Columns record
 * a width for their zone; strips below the first child of a compound column
 * record a height. Anything non-canonical simply yields no measurement and
 * falls back to hints/defaults.
 */
function measureZoneSizes(
  root: SerializedNode,
  orientation: Orientation
): MeasuredZoneSizes {
  const measured: MeasuredZoneSizes = { widths: {}, heights: {} };
  if (isLeafNode(root) || orientation !== Orientation.HORIZONTAL) {
    return measured;
  }

  for (const column of root.data) {
    const zones = [...zonesInNode(column)];
    if (zones.length === 1) {
      if (typeof column.size === 'number' && column.size > 0) {
        measured.widths[zones[0]] = column.size;
      }
      continue;
    }

    if (isLeafNode(column) || zones.length === 0) continue;

    // Compound (center) column: width belongs to the first row's zone, and
    // each later single-zone row is a bottom strip with a height.
    column.data.forEach((row, index) => {
      const rowZones = [...zonesInNode(row)];
      if (rowZones.length !== 1) return;

      if (index === 0) {
        if (typeof column.size === 'number' && column.size > 0) {
          measured.widths[rowZones[0]] = column.size;
        }
      } else if (typeof row.size === 'number' && row.size > 0) {
        measured.heights[rowZones[0]] = row.size;
      }
    });
  }

  return measured;
}

/**
 * Flatten a zone's groups into a single node. One leaf stays a leaf; several
 * leaves become one branch whose children follow the slot's natural axis.
 */
function buildZoneNode(
  leaves: SerializedLeaf[],
  size: number
): SerializedNode | null {
  if (leaves.length === 0) return null;

  if (leaves.length === 1) {
    const leaf = cloneLeaf(leaves[0]);
    leaf.size = size;
    return leaf;
  }

  return {
    type: 'branch',
    data: leaves.map((leaf) => cloneLeaf(leaf)),
    size,
  };
}

function synthesizeSessionLeaf(visible: boolean): SerializedLeaf {
  return {
    type: 'leaf',
    data: {
      views: [PANEL_IDS.AI_CHAT],
      activeView: PANEL_IDS.AI_CHAT,
      id: GROUP_IDS.RIGHT,
      locked: 'no-drop-target',
      hideHeader: true,
    },
    visible,
  };
}

/**
 * True when a serialized layout is already in the canonical shape for
 * `arrangement`, so a restore can `fromJSON` it verbatim instead of running
 * the rebuild transform. The transform re-synthesizes the grid and can only
 * approximate column widths from measurements — a lossy step (e.g. it resets
 * user-dragged widths when the editor area is collapsed) that must be
 * reserved for actual arrangement changes and legacy-layout migration, never
 * for a plain restore: a faithful restore preserves user-dragged widths,
 * group ids, and visibility exactly.
 */
export function serializedLayoutMatchesArrangement(
  layout: SerializedDockview,
  arrangement: LayoutArrangement
): boolean {
  const root = layout.grid?.root as SerializedNode | undefined;
  if (!root || isLeafNode(root)) return false;
  if (layout.grid.orientation !== Orientation.HORIZONTAL) return false;
  const columns = root.data;
  if (columns.length !== 3) return false;

  const [left, center, right] = columns.map((column) => [
    ...zonesInNode(column),
  ]);
  const isExactly = (zones: LayoutZone[], expected: LayoutZone) =>
    zones.length === 1 && zones[0] === expected;

  if (!isExactly(left, arrangement.left)) return false;
  if (!isExactly(right, arrangement.right)) return false;
  // The center column holds the center zone, optionally with the bottom-slot
  // zone as a strip underneath it.
  if (!center.includes(arrangement.center)) return false;
  return center.every(
    (zone) => zone === arrangement.center || zone === arrangement.bottom
  );
}

export function arrangeSerializedLayout(
  layout: SerializedDockview,
  arrangement: LayoutArrangement,
  options?: ArrangeLayoutOptions
): SerializedDockview {
  const root = layout.grid?.root as SerializedNode | undefined;
  if (!root) return layout;

  const gridWidth =
    layout.grid.width > 0 ? layout.grid.width : FALLBACK_GRID_WIDTH;
  const gridHeight =
    layout.grid.height > 0 ? layout.grid.height : FALLBACK_GRID_HEIGHT;

  const allLeaves: SerializedLeaf[] = [];
  collectLeaves(root, allLeaves);

  const zoneLeaves: Record<LayoutZone, SerializedLeaf[]> = {
    dock: [],
    workspace: [],
    session: [],
    terminal: [],
  };
  for (const leaf of allLeaves) {
    zoneLeaves[classifyLeafZone(leaf)].push(leaf);
  }

  const panels = { ...layout.panels };
  if (
    zoneLeaves.session.length === 0 &&
    (options?.ensureSessionPanel ?? true)
  ) {
    zoneLeaves.session.push(
      synthesizeSessionLeaf(options?.sessionVisible ?? true)
    );
    if (!panels[PANEL_IDS.AI_CHAT]) {
      panels[PANEL_IDS.AI_CHAT] = {
        id: PANEL_IDS.AI_CHAT,
        contentComponent: PANEL_IDS.AI_CHAT,
        title: 'Sessions',
      };
    }
  }

  const measured = measureZoneSizes(root, layout.grid.orientation);
  const resolveWidth = (zone: LayoutZone): number =>
    measured.widths[zone] ??
    options?.fallbackSizes?.[zone]?.width ??
    ZONE_DEFAULT_SIZES[zone].width;
  const resolveHeight = (zone: LayoutZone): number =>
    measured.heights[zone] ??
    options?.fallbackSizes?.[zone]?.height ??
    ZONE_DEFAULT_SIZES[zone].height;

  const zoneAt = (slot: (typeof LAYOUT_SLOTS)[number]): LayoutZone =>
    arrangement[slot];
  const hasZone = (zone: LayoutZone): boolean => zoneLeaves[zone].length > 0;

  // Column widths: zones simply keep their own width when slots swap — a
  // swap conserves the total, so nothing is recomputed. Only zones without
  // a width history (e.g. coming from the bottom strip) fall back to their
  // stored/default width; any resulting drift from the full grid width is
  // absorbed proportionally by dockview's layout pass.
  const leftWidth = hasZone(zoneAt('left')) ? resolveWidth(zoneAt('left')) : 0;
  const rightWidth = hasZone(zoneAt('right'))
    ? resolveWidth(zoneAt('right'))
    : 0;
  const hasCenterColumn =
    hasZone(zoneAt('center')) || hasZone(zoneAt('bottom'));
  const centerWidth = !hasCenterColumn
    ? 0
    : hasZone(zoneAt('center'))
      ? resolveWidth(zoneAt('center'))
      : Math.max(gridWidth - leftWidth - rightWidth, 0);

  let bottomHeight = hasZone(zoneAt('bottom'))
    ? resolveHeight(zoneAt('bottom'))
    : 0;
  if (bottomHeight > 0 && gridHeight - bottomHeight < CENTER_MIN_HEIGHT) {
    bottomHeight = Math.max(gridHeight - CENTER_MIN_HEIGHT, 0);
  }
  const centerHeight = gridHeight - bottomHeight;

  const leftNode = buildZoneNode(zoneLeaves[zoneAt('left')], leftWidth);
  const rightNode = buildZoneNode(zoneLeaves[zoneAt('right')], rightWidth);
  const centerContentNode = buildZoneNode(
    zoneLeaves[zoneAt('center')],
    centerHeight
  );
  const bottomNode = buildZoneNode(zoneLeaves[zoneAt('bottom')], bottomHeight);

  let centerColumn: SerializedNode | null = null;
  if (centerContentNode && bottomNode) {
    centerColumn = {
      type: 'branch',
      data: [centerContentNode, bottomNode],
      size: centerWidth,
    };
  } else if (centerContentNode) {
    centerContentNode.size = centerWidth;
    centerColumn = centerContentNode;
  } else if (bottomNode) {
    bottomNode.size = centerWidth;
    centerColumn = bottomNode;
  }

  const columns = [leftNode, centerColumn, rightNode].filter(
    (node): node is SerializedNode => node !== null
  );
  if (columns.length === 0) return layout;

  const newRoot: SerializedNode =
    columns.length === 1
      ? columns[0]
      : { type: 'branch', data: columns, size: gridHeight };

  const remainingGroupIds = new Set(
    columns.flatMap((column) => {
      const leaves: SerializedLeaf[] = [];
      collectLeaves(column, leaves);
      return leaves.map((leaf) => leaf.data.id);
    })
  );

  return {
    ...layout,
    grid: {
      ...layout.grid,
      root: newRoot as SerializedDockview['grid']['root'],
      width: gridWidth,
      height: gridHeight,
      orientation: Orientation.HORIZONTAL,
    },
    panels,
    activeGroup:
      layout.activeGroup && remainingGroupIds.has(layout.activeGroup)
        ? layout.activeGroup
        : undefined,
  };
}
