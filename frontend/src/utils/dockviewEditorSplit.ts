import { Orientation, type DockviewApi } from 'dockview-core';
import { isPlaceholderPanelId } from '@/utils/dockviewGroupPolicy';

export type EditorSplitDirection = 'left' | 'right' | 'below';

export const TERMINAL_SHELF_HEIGHT_RATIO = 0.4;

interface GroupLike {
  id: string;
  panels: ReadonlyArray<{ id: string }>;
}

interface EditorGroupTarget extends GroupLike {
  element?: HTMLElement;
  api?: {
    moveTo: (options: {
      group: unknown;
      position?: 'right';
      skipSetActive?: boolean;
    }) => void;
  };
}

interface DockviewSplitHost {
  gridview: DockviewGrid;
  createGroupAtLocation: (
    location: number[],
    size?: number,
    options?: { id?: string }
  ) => ReturnType<DockviewApi['addGroup']>;
  createGroup: (options?: {
    id?: string;
  }) => ReturnType<DockviewApi['addGroup']>;
}

export function indexInGridParent(element: HTMLElement): number {
  const parentElement = element.parentElement;
  if (!parentElement) {
    throw new Error('Invalid grid element');
  }
  let el = parentElement.firstElementChild;
  let index = 0;
  while (el !== element && el !== parentElement.lastElementChild && el) {
    el = el.nextElementSibling;
    index += 1;
  }
  return index;
}

/** Dockview grid path for a group element. Mirrors dockview's DOM walk. */
export function gridLocationFromElement(element: HTMLElement): number[] {
  const parentElement = element.parentElement;
  if (!parentElement) {
    throw new Error('Invalid grid element');
  }
  if (/\bdv-grid-view\b/.test(parentElement.className)) {
    return [];
  }
  const index = indexInGridParent(parentElement);
  const ancestor = parentElement.parentElement?.parentElement?.parentElement;
  if (!ancestor) {
    throw new Error('Invalid grid element');
  }
  return [...gridLocationFromElement(ancestor), index];
}

export function commonLocationPrefix(paths: readonly number[][]): number[] {
  if (paths.length === 0) return [];
  const [first, ...rest] = paths;
  let length = first.length;
  for (const path of rest) {
    let index = 0;
    while (
      index < length &&
      index < path.length &&
      path[index] === first[index]
    ) {
      index += 1;
    }
    length = index;
  }
  return first.slice(0, length);
}

/** Orientation of the split that contains the node at `location`. */
export function locationOrientation(
  root: Orientation,
  location: readonly number[]
): Orientation {
  return location.length % 2 === 0
    ? root === Orientation.HORIZONTAL
      ? Orientation.VERTICAL
      : Orientation.HORIZONTAL
    : root;
}

function relativeBelow(
  location: readonly number[],
  root: Orientation
): number[] {
  const axis = locationOrientation(root, location);
  if (axis === Orientation.VERTICAL) {
    const index = location[location.length - 1] ?? 0;
    return [...location.slice(0, -1), index + 1];
  }
  return [...location, 1];
}

/**
 * Where to insert a group that sits under every editor group and spans their
 * shared width. Side-by-side groups get one row beneath both. A single group
 * splits downward. Groups that are already stacked grow below the lowest one.
 * Returns null when the groups do not share a branch (callers fall back to
 * splitting one group).
 */
export function locationBelowGroups(
  paths: readonly number[][],
  root: Orientation
): number[] | null {
  if (paths.length === 0) return null;
  const prefix = commonLocationPrefix(paths);
  const extendsBeyond = paths.some((path) => path.length > prefix.length);
  if (prefix.length === 0 && extendsBeyond) return null;
  if (!extendsBeyond) {
    return relativeBelow(prefix, root);
  }
  const parentAxis = locationOrientation(root, prefix);
  if (parentAxis === Orientation.VERTICAL) {
    return relativeBelow(prefix, root);
  }
  const childIndexes = paths.map((path) => path[prefix.length] ?? 0);
  return [...prefix, Math.max(...childIndexes) + 1];
}

export function leastPopulatedEditorGroup<T extends GroupLike>(
  groups: readonly T[],
  activeGroupId?: string | null
): T | undefined {
  if (groups.length === 0) return undefined;
  const ranked = groups.map((group) => ({
    group,
    count: group.panels.filter((panel) => !isPlaceholderPanelId(panel.id))
      .length,
  }));
  const min = Math.min(...ranked.map((entry) => entry.count));
  const tied = ranked.filter((entry) => entry.count === min);
  return (
    tied.find((entry) => entry.group.id === activeGroupId)?.group ??
    tied[0]?.group
  );
}

export function terminalShelfHeight(gridHeight: number): number {
  if (!Number.isFinite(gridHeight) || gridHeight <= 0) return 0;
  return Math.max(120, Math.round(gridHeight * TERMINAL_SHELF_HEIGHT_RATIO));
}

export function showGroupHeader(group: {
  element?: HTMLElement;
  model?: { header?: { hidden?: boolean } };
}): void {
  try {
    if (group.model?.header) {
      group.model.header.hidden = false;
    }
  } catch {
    // CSS class removal still reveals the tab strip.
  }
  group.element?.classList.remove('dv-header-hidden');
}

interface GridChild {
  element?: HTMLElement;
}

interface GridBranch extends GridChild {
  orientation: Orientation;
  proportionalLayout: boolean;
  styles: unknown;
  disabled: boolean;
  margin: number;
  height: number;
  children: GridChild[];
  getChildSize: (index: number) => number;
  removeChild: (index: number) => GridChild;
  addChild: (node: GridChild, size: number, index: number) => void;
  resizeChild: (index: number, size: number) => void;
}

interface DockviewGrid {
  orientation: Orientation;
  root?: GridBranch;
}

type BranchConstructor = new (
  orientation: Orientation,
  proportionalLayout: boolean,
  styles: unknown,
  size: number,
  orthogonalSize: number,
  disabled: boolean,
  margin: number
) => GridBranch;

type LeafConstructor = new (
  view: unknown,
  orientation: Orientation,
  orthogonalSize: number,
  size?: number
) => GridChild;

function branchAt(
  root: GridBranch,
  location: readonly number[]
): GridBranch | null {
  let node: GridChild = root;
  for (const index of location) {
    const child = (node as GridBranch).children?.[index];
    if (!child) return null;
    node = child;
  }
  if (!(node as GridBranch).children) return null;
  return node as GridBranch;
}

/**
 * Dockview's "below" split wraps a single leaf, so side-by-side editor groups
 * would collapse into the anchor column. Reparent that contiguous run under
 * one vertical branch and keep each group's width.
 */
function placeShelfAcrossSiblings(
  api: DockviewApi,
  editorGroups: readonly EditorGroupTarget[],
  options: { id: string; height: number }
): ReturnType<DockviewApi['addGroup']> | null {
  const host = (api as unknown as { component?: DockviewSplitHost }).component;
  const grid = host?.gridview as DockviewGrid | undefined;
  const root = grid?.root;
  if (!host?.createGroup || !root) return null;

  let located: Array<{ group: EditorGroupTarget; path: number[] }>;
  try {
    located = editorGroups.map((group) => ({
      group,
      path: group.element ? gridLocationFromElement(group.element) : [],
    }));
  } catch {
    return null;
  }
  if (located.some((entry) => entry.path.length === 0)) return null;
  if (located.length !== editorGroups.length || located.length === 0) {
    return null;
  }
  located.sort((a, b) => {
    const length = Math.max(a.path.length, b.path.length);
    for (let index = 0; index < length; index += 1) {
      const delta = (a.path[index] ?? -1) - (b.path[index] ?? -1);
      if (delta !== 0) return delta;
    }
    return 0;
  });

  const parentPath = located[0].path.slice(0, -1);
  const sameParent = located.every(
    (entry) =>
      entry.path.length === parentPath.length + 1 &&
      parentPath.every((part, index) => entry.path[index] === part)
  );
  if (!sameParent) return null;

  const parent = branchAt(root, parentPath);
  if (!parent) return null;
  const indexes = located.map(
    (entry) => entry.path[entry.path.length - 1] ?? 0
  );
  const start = Math.min(...indexes);
  const end = Math.max(...indexes);
  if (end - start + 1 !== located.length) return null;
  if (
    located.some(
      (entry) =>
        parent.children[entry.path[entry.path.length - 1] ?? 0]?.element !==
        entry.group.element
    )
  ) {
    return null;
  }

  const snapshot = parent.children.map((_, index) =>
    parent.getChildSize(index)
  );
  const sizes = snapshot.slice(start, end + 1);
  const totalWidth = sizes.reduce((sum, size) => sum + size, 0);
  const fullHeight = parent.height;
  const shelfHeight =
    options.height > 0 && options.height < fullHeight
      ? options.height
      : Math.round(fullHeight * TERMINAL_SHELF_HEIGHT_RATIO);
  const topHeight = Math.max(fullHeight - shelfHeight, 0);
  if (totalWidth <= 0 || topHeight <= 0) return null;

  const nodes: GridChild[] = [];
  for (let index = end; index >= start; index -= 1) {
    nodes.push(parent.removeChild(index));
  }
  nodes.reverse();

  const Branch = parent.constructor as BranchConstructor;
  const Leaf = nodes[0]?.constructor as LeafConstructor;
  const shelf = host.createGroup({ id: options.id });
  const row = new Branch(
    Orientation.HORIZONTAL,
    parent.proportionalLayout,
    parent.styles,
    totalWidth,
    topHeight,
    parent.disabled,
    parent.margin
  );
  nodes.forEach((node, index) => row.addChild(node, sizes[index] ?? 0, index));
  const shelfLeaf = new Leaf(
    shelf,
    Orientation.HORIZONTAL,
    totalWidth,
    shelfHeight
  );
  const column = new Branch(
    Orientation.VERTICAL,
    parent.proportionalLayout,
    parent.styles,
    fullHeight,
    totalWidth,
    parent.disabled,
    parent.margin
  );
  column.addChild(row, topHeight, 0);
  column.addChild(shelfLeaf, shelfHeight, 1);
  parent.addChild(column, totalWidth, start);

  for (let index = 0; index < start; index += 1) {
    parent.resizeChild(index, snapshot[index] ?? 0);
  }
  parent.resizeChild(start, totalWidth);
  for (let index = end + 1; index < snapshot.length; index += 1) {
    parent.resizeChild(start + 1 + (index - (end + 1)), snapshot[index] ?? 0);
  }
  sizes.forEach((size, index) => row.resizeChild(index, size));
  column.resizeChild(0, topHeight);
  column.resizeChild(1, shelfHeight);

  return shelf;
}

function placeShelfUnderLooseGroups(
  api: DockviewApi,
  editorGroups: readonly EditorGroupTarget[],
  options: { id: string; height: number }
): ReturnType<DockviewApi['addGroup']> {
  const anchor = editorGroups[0];
  const panelId = anchor?.panels[0]?.id;
  if (!panelId) {
    throw new Error('No editor group to split');
  }

  const shelf = api.addGroup({
    id: options.id,
    referencePanel: panelId,
    direction: 'below',
    initialHeight: options.height,
    skipSetActive: true,
  });

  // Used when the grid cannot be reparented (tests, or groups that do not
  // share a parent). A single "below" only covers the anchor, so the other
  // editor groups are pulled into the row above the shelf.
  let edge: EditorGroupTarget = anchor;
  for (const group of editorGroups.slice(1)) {
    if (!group.api?.moveTo) continue;
    try {
      group.api.moveTo({
        group: edge,
        position: 'right',
        skipSetActive: true,
      });
      edge = group;
    } catch {
      // The shelf still exists under the groups that did move.
    }
  }

  return shelf;
}

export function addGroupBelowEditorGroups(
  api: DockviewApi,
  editorGroups: readonly GroupLike[],
  options: { id: string; height: number }
): ReturnType<DockviewApi['addGroup']> {
  const groups = editorGroups as readonly EditorGroupTarget[];
  const host = (api as unknown as { component?: DockviewSplitHost }).component;
  const loose = () => placeShelfUnderLooseGroups(api, groups, options);

  if (!host?.createGroupAtLocation || !host.gridview) {
    return loose();
  }

  let location: number[] | null = null;
  try {
    const paths = groups
      .map((group) => group.element)
      .filter((element): element is HTMLElement => Boolean(element))
      .map((element) => gridLocationFromElement(element));
    location = locationBelowGroups(paths, host.gridview.orientation);
  } catch {
    location = null;
  }

  if (!location) {
    const spanned = placeShelfAcrossSiblings(api, groups, options);
    return spanned ?? loose();
  }

  try {
    return host.createGroupAtLocation(location, options.height, {
      id: options.id,
    });
  } catch {
    return loose();
  }
}
