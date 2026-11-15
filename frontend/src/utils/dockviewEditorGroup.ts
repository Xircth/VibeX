import { builtinPanelTitle } from '@/lib/builtinPanelTitles';
import type { DockviewApi } from 'dockview-react';
import {
  slotOfZone,
  type LayoutArrangement,
  type LayoutZone,
} from '@/lib/layoutArrangement';
import {
  GROUP_IDS,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_IDS,
  useLayoutStore,
} from '@/stores/useLayoutStore';
import {
  BOTTOM_PANEL_IDS,
  getNextEditorGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
  isSessionPanelId,
  listLeftShellNavGroups,
  listRightShellNavGroups,
  listSessionGroups,
} from '@/utils/dockviewGroupPolicy';
import { assignDockviewGroupIdAndRole } from '@/utils/dockviewGroupRole';
import { gridLocationFromElement } from '@/utils/dockviewEditorSplit';
import {
  DEFAULT_SESSION_PANEL_WIDTH,
  settleDockviewGroupWidths,
} from '@/utils/dockviewStartupSizing';
import { MIN_LEFT_PANEL_WIDTH } from '@/utils/dockviewWorkspaceConstraints';

/**
 * Dockview's built-in group minimum is 100px. Adding a group without
 * `initialWidth` uses that minimum as the size, which crushes the editor
 * column after the last tab is closed and the group is recreated.
 */
export const CRUSHED_EDITOR_COLUMN_WIDTH = 160;

/** Floor for the flexible workspace column when restoring side widths. */
export const MIN_EDITOR_COLUMN_WIDTH = 320;

type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;

export interface EnsureWelcomeEditorGroupOptions {
  arrangement: LayoutArrangement;
  /** Session column width from before the editor group disappeared. */
  sessionWidth?: number;
  /** Dock column width from before the editor group disappeared. */
  dockWidth?: number;
}

function getLeftGroup(api: DockviewApi) {
  return (
    api.getGroup(GROUP_IDS.LEFT) ??
    api.groups.find(
      (group) =>
        isLeftGroup(group) &&
        group.element?.getAttribute('data-shell-nav-side') !== 'right'
    ) ??
    api.groups.find((group) => isLeftGroup(group))
  );
}

function getBottomGroup(api: DockviewApi) {
  return (
    api.getGroup(GROUP_IDS.BOTTOM) ??
    api.groups.find((group) => isBottomGroup(group))
  );
}

function getRightGroup(api: DockviewApi) {
  return (
    api.getGroup(GROUP_IDS.RIGHT) ??
    api.groups.find((group) => isSessionGroup(group))
  );
}

function getEditorGroups(api: DockviewApi) {
  return api.groups.filter((group) => isEditorGroup(group));
}

function isSideColumn(slot: ReturnType<typeof slotOfZone>): boolean {
  return slot !== 'center' && slot !== 'bottom';
}

type ColumnKind = 'shellNav' | 'editor' | 'session' | 'bottom' | 'other';

interface CapturedGroupGeometry {
  group: DockviewGroup;
  id: string;
  width: number;
  kind: ColumnKind;
  location: number[];
  /** Groups with the same parent path share one split. */
  parentPath: string;
  /** That split assigns width. A vertical stack assigns height instead. */
  sharesWidth: boolean;
  index: number;
}

interface HorizontalBranchSummary {
  branchIndex: number;
  kind: ColumnKind;
  reps: Array<{ group: DockviewGroup; width: number }>;
}

function classifyColumnGroup(group: DockviewGroup): ColumnKind {
  if (isLeftGroup(group)) return 'shellNav';
  if (isBottomGroup(group)) return 'bottom';
  if (isSessionGroup(group)) return 'session';
  if (isEditorGroup(group)) return 'editor';
  return 'other';
}

function isZoneBKind(kind: ColumnKind): boolean {
  return kind === 'editor' || kind === 'session' || kind === 'bottom';
}

function hasLocationPrefix(
  location: readonly number[],
  prefix: readonly number[]
): boolean {
  if (location.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (location[index] !== prefix[index]) return false;
  }
  return true;
}

function isLiveVisibleGroup(api: DockviewApi, group: DockviewGroup): boolean {
  return (
    api.groups.some((candidate) => candidate === group) && group.api.isVisible
  );
}

/**
 * Dockview's root split is horizontal. A group's location length is odd when
 * its parent split sizes children by width (root children are [i], a nested
 * horizontal row is [branch, row, i]).
 */
function columnSharesWidth(location: readonly number[]): boolean {
  return location.length % 2 === 1;
}

function captureZoneColumnWidths(api: DockviewApi): CapturedGroupGeometry[] {
  const columns: CapturedGroupGeometry[] = [];
  for (const group of api.groups) {
    if (!group.api.isVisible || !(group.api.width > 0)) continue;
    let location: number[];
    try {
      location = gridLocationFromElement(group.element);
    } catch {
      continue;
    }
    columns.push({
      group,
      id: group.id,
      width: group.api.width,
      kind: classifyColumnGroup(group),
      location,
      parentPath: location.slice(0, -1).join('.'),
      sharesWidth: columnSharesWidth(location),
      index: location[location.length - 1] ?? 0,
    });
  }
  return columns;
}

function summarizeHorizontalBranches(
  api: DockviewApi,
  snapshot: readonly CapturedGroupGeometry[],
  hPrefix: readonly number[],
  excludedBranch: number,
  removedGroup: DockviewGroup
): HorizontalBranchSummary[] {
  const depth = hPrefix.length;
  const byBranch = new Map<number, CapturedGroupGeometry[]>();

  for (const entry of snapshot) {
    if (entry.group === removedGroup) continue;
    if (!isLiveVisibleGroup(api, entry.group)) continue;
    if (!hasLocationPrefix(entry.location, hPrefix)) continue;
    if (entry.location.length <= depth) continue;
    const branchIndex = entry.location[depth]!;
    if (branchIndex === excludedBranch) continue;
    const list = byBranch.get(branchIndex) ?? [];
    list.push(entry);
    byBranch.set(branchIndex, list);
  }

  const summaries: HorizontalBranchSummary[] = [];
  const sortedBranchIndices = [...byBranch.keys()].sort((a, b) => a - b);

  for (const branchIndex of sortedBranchIndices) {
    const entries = byBranch.get(branchIndex)!;
    const kind: ColumnKind = entries.some((item) => item.kind === 'shellNav')
      ? 'shellNav'
      : entries.some((item) => item.kind === 'editor')
        ? 'editor'
        : entries.some((item) => item.kind === 'session')
          ? 'session'
          : entries.some((item) => item.kind === 'bottom')
            ? 'bottom'
            : 'other';

    const directLeaf = entries.find(
      (item) => item.location.length === depth + 1
    );
    if (directLeaf) {
      summaries.push({
        branchIndex,
        kind,
        reps: [{ group: directLeaf.group, width: directLeaf.width }],
      });
      continue;
    }

    const preferredRowEntry =
      entries.find(
        (item) => item.kind === 'editor' || item.kind === 'session'
      ) ?? entries[0]!;
    const vSlot = preferredRowEntry.location[depth + 1]!;
    const rowEntries = entries.filter(
      (item) => item.location[depth + 1] === vSlot
    );
    const verticalLeaf = rowEntries.find(
      (item) => item.location.length === depth + 2
    );
    const reps = verticalLeaf
      ? [{ group: verticalLeaf.group, width: verticalLeaf.width }]
      : rowEntries
          .filter((item) => item.location.length === depth + 3)
          .sort((a, b) => a.index - b.index)
          .map((item) => ({ group: item.group, width: item.width }));

    if (reps.length > 0) {
      summaries.push({ branchIndex, kind, reps });
    }
  }

  return summaries;
}

/**
 * Dockview gives a removed view's size to every flexible sibling, so closing
 * any Zone B tab bar (editor or session) also resizes Zone A shell-nav columns.
 * Lock Zone A widths verbatim and distribute the closed column's width across
 * remaining Zone B columns (preferring same-kind siblings first, then any
 * remaining Zone B columns).
 */
function rebalanceZoneColumnsAfterRemoval(
  api: DockviewApi,
  snapshot: readonly CapturedGroupGeometry[],
  removedGroup: DockviewGroup
): void {
  const removed = snapshot.find(
    (column) => column.group === removedGroup || column.id === removedGroup.id
  );
  if (!removed || (removed.kind !== 'editor' && removed.kind !== 'session')) {
    return;
  }

  let hDepth = removed.location.length - 1;
  while (hDepth >= 0) {
    if (hDepth % 2 === 1) {
      const vPrefix = removed.location.slice(0, hDepth);
      const hasVerticalSurvivor = snapshot.some(
        (entry) =>
          entry.group !== removedGroup &&
          hasLocationPrefix(entry.location, vPrefix) &&
          isLiveVisibleGroup(api, entry.group)
      );
      if (hasVerticalSurvivor) {
        return;
      }
      hDepth -= 1;
      continue;
    }

    const hPrefix = removed.location.slice(0, hDepth);
    const removedBranch = removed.location[hDepth]!;
    const branchPrefix = [...hPrefix, removedBranch];
    const hasSameBranchSurvivor = snapshot.some(
      (entry) =>
        entry.group !== removedGroup &&
        hasLocationPrefix(entry.location, branchPrefix) &&
        isLiveVisibleGroup(api, entry.group)
    );
    if (hasSameBranchSurvivor) {
      return;
    }

    const branches = summarizeHorizontalBranches(
      api,
      snapshot,
      hPrefix,
      removedBranch,
      removedGroup
    );
    if (branches.length > 0 || hDepth === 0) {
      break;
    }
    hDepth -= 1;
  }

  if (hDepth < 0) return;

  const hPrefix = removed.location.slice(0, hDepth);
  const removedBranch = removed.location[hDepth]!;
  const branches = summarizeHorizontalBranches(
    api,
    snapshot,
    hPrefix,
    removedBranch,
    removedGroup
  );

  if (hDepth === 0 && !branches.some((branch) => isZoneBKind(branch.kind))) {
    const snapshotGroups = new Set(snapshot.map((entry) => entry.group));
    const newlyVisibleZoneBGroups = api.groups.filter(
      (group) =>
        group !== removedGroup &&
        group.api.isVisible &&
        !snapshotGroups.has(group) &&
        (isEditorGroup(group) || isSessionGroup(group))
    );
    for (const [idx, group] of newlyVisibleZoneBGroups.entries()) {
      branches.push({
        branchIndex: 1000 + idx,
        kind: isSessionGroup(group) ? 'session' : 'editor',
        reps: [{ group, width: 0 }],
      });
    }
  }

  const sameKindBranches = branches.filter(
    (branch) => branch.kind === removed.kind
  );
  const recipientBranches =
    sameKindBranches.length > 0
      ? sameKindBranches
      : branches.filter((branch) => isZoneBKind(branch.kind));

  if (recipientBranches.length === 0) return;

  const recipientSet = new Set(recipientBranches);
  const recipientReps = recipientBranches.flatMap((branch) => branch.reps);
  const totalPoolWidth =
    removed.width + recipientReps.reduce((sum, rep) => sum + rep.width, 0);
  const baseShare = Math.floor(totalPoolWidth / recipientReps.length);
  let remainder = totalPoolWidth - baseShare * recipientReps.length;

  const targets: Array<{ group: DockviewGroup; width: number }> = [];
  const seenGroups = new Set<DockviewGroup>();
  const pushTarget = (group: DockviewGroup, width: number) => {
    if (seenGroups.has(group) || !(width > 0)) return;
    seenGroups.add(group);
    targets.push({ group, width });
  };

  if (hDepth > 0) {
    const rootBranches = summarizeHorizontalBranches(
      api,
      snapshot,
      [],
      removed.location[0]!,
      removedGroup
    );
    for (const rootBranch of rootBranches) {
      for (const rep of rootBranch.reps) {
        pushTarget(rep.group, rep.width);
      }
    }
  }

  for (const branch of branches) {
    if (recipientSet.has(branch)) continue;
    for (const rep of branch.reps) {
      pushTarget(rep.group, rep.width);
    }
  }

  for (const rep of recipientReps) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    pushTarget(rep.group, baseShare + extra);
  }

  if (targets.length > 0) {
    settleDockviewGroupWidths(targets);
  }
}

export function installEditorColumnWidthRebalance(
  api: DockviewApi,
  options?: { shouldRebalance?: () => boolean }
): { dispose(): void } {
  let snapshot = captureZoneColumnWidths(api);
  let refreshQueued = false;
  let disposed = false;
  const groupDisposables = new Map<DockviewGroup, Array<{ dispose(): void }>>();

  const scheduleSnapshotRefresh = () => {
    if (refreshQueued || disposed) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (disposed) return;
      const next = captureZoneColumnWidths(api);
      if (
        next.length > 0 ||
        api.groups.every((group) => !group.api.isVisible)
      ) {
        snapshot = next;
      }
    });
  };

  const bindGroupListeners = (group: DockviewGroup) => {
    if (groupDisposables.has(group)) return;
    const subs: Array<{ dispose(): void }> = [];
    if (group.api?.onDidDimensionsChange) {
      subs.push(group.api.onDidDimensionsChange(scheduleSnapshotRefresh));
    }
    if (group.api?.onDidVisibilityChange) {
      subs.push(group.api.onDidVisibilityChange(scheduleSnapshotRefresh));
    }
    groupDisposables.set(group, subs);
  };

  for (const group of api.groups) {
    bindGroupListeners(group);
  }

  const addGroupDisposable = api.onDidAddGroup((group) => {
    bindGroupListeners(group);
    scheduleSnapshotRefresh();
  });

  const removePanelDisposable = api.onDidRemovePanel(() => {
    const live = captureZoneColumnWidths(api);
    if (live.length > 0) {
      snapshot = live;
    }
  });

  const layoutDisposable = api.onDidLayoutChange(() => {
    const live = captureZoneColumnWidths(api);
    if (live.length > 0) {
      snapshot = live;
    }
    scheduleSnapshotRefresh();
  });

  const removeDisposable = api.onDidRemoveGroup((group) => {
    const groupSubs = groupDisposables.get(group);
    if (groupSubs) {
      for (const sub of groupSubs) sub.dispose();
      groupDisposables.delete(group);
    }
    const shouldRebalance = options?.shouldRebalance?.() ?? true;
    if (shouldRebalance) {
      rebalanceZoneColumnsAfterRemoval(api, snapshot, group);
    }
    snapshot = captureZoneColumnWidths(api);
  });

  return {
    dispose() {
      disposed = true;
      addGroupDisposable.dispose();
      removePanelDisposable.dispose();
      layoutDisposable.dispose();
      removeDisposable.dispose();
      for (const subs of groupDisposables.values()) {
        for (const sub of subs) sub.dispose();
      }
      groupDisposables.clear();
    },
  };
}

export function groupForZone(
  api: DockviewApi,
  zone: LayoutZone
): DockviewGroup | undefined {
  switch (zone) {
    case 'dock':
      return getLeftGroup(api);
    case 'terminal':
      return getBottomGroup(api);
    case 'session':
      return getRightGroup(api);
    default:
      return getEditorGroups(api)[0];
  }
}

/**
 * Live widths of the left/right slots, plus whether the center slot is
 * currently shown. Taken before a visibility change so leftover width can
 * be given to the neighboring column instead of Dockview's last sibling.
 */
export interface SlotColumnSnapshot {
  left?: number;
  right?: number;
  centerVisible: boolean;
  shellNavWidths?: ReadonlyArray<{ group: DockviewGroup; width: number }>;
  editorWidths?: ReadonlyArray<{ group: DockviewGroup; width: number }>;
  sessionWidths?: ReadonlyArray<{ group: DockviewGroup; width: number }>;
}

function visibleHorizontalEditorRepresentatives(
  api: DockviewApi
): DockviewGroup[] {
  const captured = captureZoneColumnWidths(api);
  if (captured.length === 0) {
    return getEditorGroups(api).filter((group) => group.api.isVisible);
  }
  const branches = summarizeHorizontalBranches(
    api,
    captured,
    [],
    -1,
    {} as DockviewGroup
  );
  return branches
    .filter((branch) => branch.kind === 'editor')
    .flatMap((branch) => branch.reps.map((rep) => rep.group));
}

export function snapshotSlotColumnWidths(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  preferredPrimaryDockWidth?: number
): SlotColumnSnapshot {
  const left = groupForZone(api, arrangement.left);
  const center = groupForZone(api, arrangement.center);
  const right = groupForZone(api, arrangement.right);
  const primaryLeftGroup = getLeftGroup(api);
  const shellNavGroups = [
    ...listLeftShellNavGroups(api.groups),
    ...listRightShellNavGroups(api.groups),
  ];
  const shellNavWidths = shellNavGroups.flatMap((group) => {
    if (!group.api.isVisible) return [];
    const width =
      group === primaryLeftGroup &&
      preferredPrimaryDockWidth &&
      preferredPrimaryDockWidth > 0
        ? preferredPrimaryDockWidth
        : group.api.width;
    return width > 0 ? [{ group, width }] : [];
  });
  const editorWidths = visibleHorizontalEditorRepresentatives(api).flatMap(
    (group) =>
      group.api.isVisible && group.api.width > 0
        ? [{ group, width: group.api.width }]
        : []
  );
  const sessionWidths = listSessionGroups(api.groups).flatMap((group) =>
    group.api.isVisible && group.api.width > 0
      ? [{ group, width: group.api.width }]
      : []
  );
  const centerIsVisible =
    arrangement.center === 'workspace'
      ? editorWidths.length > 0 || !!center?.api.isVisible
      : arrangement.center === 'session'
        ? sessionWidths.length > 0 || !!center?.api.isVisible
        : !!center?.api.isVisible;
  return {
    left:
      preferredPrimaryDockWidth && preferredPrimaryDockWidth > 0
        ? preferredPrimaryDockWidth
        : left?.api.isVisible
          ? left.api.width
          : undefined,
    right: right?.api.isVisible ? right.api.width : undefined,
    centerVisible: centerIsVisible,
    shellNavWidths,
    editorWidths,
    sessionWidths,
  };
}

/**
 * Left/right leftover goes to the flexible center slot; when only one non-dock
 * zone remains visible, it absorbs all non-dock width. All Zone A shell-nav
 * columns keep their exact pixel widths from before the visibility change.
 */
export function settleSlotColumnWidths(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  snapshot: SlotColumnSnapshot
): void {
  const left = groupForZone(api, arrangement.left);
  const right = groupForZone(api, arrangement.right);
  const targets: Array<{ group: DockviewGroup; width: number }> = [];
  const seenGroups = new Set<DockviewGroup>();
  const pushTarget = (group: DockviewGroup, width: number) => {
    if (seenGroups.has(group) || !group.api.isVisible || !(width > 0)) return;
    seenGroups.add(group);
    targets.push({ group, width });
  };

  let totalShellNavWidth = 0;
  if (snapshot.shellNavWidths && snapshot.shellNavWidths.length > 0) {
    for (const item of snapshot.shellNavWidths) {
      if (item.group.api.isVisible && item.width > 0) {
        pushTarget(item.group, item.width);
        totalShellNavWidth += item.width;
      }
    }
  } else if (arrangement.left === 'dock' && left?.api.isVisible) {
    const width =
      snapshot.left && snapshot.left > 0 ? snapshot.left : left.api.width;
    if (width > 0) {
      pushTarget(left, width);
      totalShellNavWidth += width;
    }
  } else if (arrangement.right === 'dock' && right?.api.isVisible) {
    const width =
      snapshot.right && snapshot.right > 0 ? snapshot.right : right.api.width;
    if (width > 0) {
      pushTarget(right, width);
      totalShellNavWidth += width;
    }
  }

  for (const navGroup of [
    ...listLeftShellNavGroups(api.groups),
    ...listRightShellNavGroups(api.groups),
  ]) {
    if (navGroup.api.isVisible && !seenGroups.has(navGroup)) {
      const fallbackSlotWidth =
        arrangement.left === 'dock' && snapshot.left && snapshot.left > 0
          ? snapshot.left
          : arrangement.right === 'dock' && snapshot.right && snapshot.right > 0
            ? snapshot.right
            : undefined;
      const width = intendedDockColumnWidth(
        api.width,
        navGroup.api.width,
        fallbackSlotWidth
      );
      pushTarget(navGroup, width);
      totalShellNavWidth += width;
    }
  }

  const visibleSessions = listSessionGroups(api.groups).filter(
    (group) => group.api.isVisible
  );
  const visibleEditors = visibleHorizontalEditorRepresentatives(api);
  const hasVisibleEditor = visibleEditors.length > 0;
  const hasVisibleSession = visibleSessions.length > 0;

  if (!hasVisibleEditor && hasVisibleSession) {
    const availableZoneB = Math.max(
      visibleSessions.length * MIN_RIGHT_PANEL_WIDTH,
      api.width - totalShellNavWidth
    );
    const share = Math.floor(availableZoneB / visibleSessions.length);
    let remainder = availableZoneB - share * visibleSessions.length;
    for (const sessionGroup of visibleSessions) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      pushTarget(sessionGroup, Math.max(MIN_RIGHT_PANEL_WIDTH, share + extra));
    }
  } else if (hasVisibleEditor && !hasVisibleSession) {
    const availableZoneB = Math.max(
      visibleEditors.length * CRUSHED_EDITOR_COLUMN_WIDTH,
      api.width - totalShellNavWidth
    );
    const share = Math.floor(availableZoneB / visibleEditors.length);
    let remainder = availableZoneB - share * visibleEditors.length;
    for (const editorGroup of visibleEditors) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      pushTarget(editorGroup, share + extra);
    }
  } else if (hasVisibleEditor && hasVisibleSession && snapshot.centerVisible) {
    const availableZoneB = Math.max(
      MIN_EDITOR_COLUMN_WIDTH + MIN_RIGHT_PANEL_WIDTH,
      api.width - totalShellNavWidth
    );
    if (arrangement.center === 'session') {
      if (snapshot.editorWidths && snapshot.editorWidths.length > 0) {
        for (const item of snapshot.editorWidths) {
          pushTarget(item.group, item.width);
        }
      } else {
        const fallbackEditorWidth = Math.max(
          MIN_EDITOR_COLUMN_WIDTH,
          Math.floor(availableZoneB / 2)
        );
        if (arrangement.right === 'workspace' && right?.api.isVisible) {
          const width =
            snapshot.right && snapshot.right > 0
              ? snapshot.right
              : right.api.width > CRUSHED_EDITOR_COLUMN_WIDTH
                ? right.api.width
                : fallbackEditorWidth;
          pushTarget(right, width);
        } else if (arrangement.left === 'workspace' && left?.api.isVisible) {
          const width =
            snapshot.left && snapshot.left > 0
              ? snapshot.left
              : left.api.width > CRUSHED_EDITOR_COLUMN_WIDTH
                ? left.api.width
                : fallbackEditorWidth;
          pushTarget(left, width);
        }
      }
    } else {
      if (snapshot.sessionWidths && snapshot.sessionWidths.length > 0) {
        for (const item of snapshot.sessionWidths) {
          pushTarget(item.group, item.width);
        }
      } else {
        const preferredSessionWidth =
          useLayoutStore.getState().rightPanelWidth ||
          DEFAULT_SESSION_PANEL_WIDTH;
        const fallbackSessionWidth = Math.min(
          Math.max(MIN_RIGHT_PANEL_WIDTH, preferredSessionWidth),
          Math.max(
            MIN_RIGHT_PANEL_WIDTH,
            availableZoneB - MIN_EDITOR_COLUMN_WIDTH
          )
        );
        if (arrangement.right === 'session' && right?.api.isVisible) {
          const width =
            snapshot.right && snapshot.right > 0
              ? snapshot.right
              : right.api.width >= MIN_RIGHT_PANEL_WIDTH
                ? right.api.width
                : fallbackSessionWidth;
          pushTarget(right, width);
        } else if (arrangement.left === 'session' && left?.api.isVisible) {
          const width =
            snapshot.left && snapshot.left > 0
              ? snapshot.left
              : left.api.width >= MIN_RIGHT_PANEL_WIDTH
                ? left.api.width
                : fallbackSessionWidth;
          pushTarget(left, width);
        }
      }
    }
  }

  if (targets.length > 0) {
    settleDockviewGroupWidths(targets);
  }
}

export function setColumnVisible(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  group: DockviewGroup,
  visible: boolean
): void {
  setColumnsVisible(api, arrangement, [{ group, visible }]);
}

export function setLeftDockVisible(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  visible: boolean
): void {
  const groups = listLeftShellNavGroups(api.groups);
  if (groups.length === 0) return;
  setColumnsVisible(
    api,
    arrangement,
    groups.map((group) => ({ group, visible }))
  );
}

export function setRightShellNavVisible(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  visible: boolean
): void {
  const groups = listRightShellNavGroups(api.groups);
  if (groups.length === 0) return;
  setColumnsVisible(
    api,
    arrangement,
    groups.map((group) => ({ group, visible }))
  );
  if (visible) {
    const targets: Array<{ group: DockviewGroup; width: number }> = [];
    for (const group of groups) {
      if (group.api.width < MIN_LEFT_PANEL_WIDTH) {
        targets.push({
          group,
          width: intendedDockColumnWidth(api.width, group.api.width),
        });
      }
    }
    if (targets.length > 0) {
      settleDockviewGroupWidths(targets);
    }
  }
}

export function setSessionDockVisible(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  visible: boolean
): void {
  const groups = listSessionGroups(api.groups);
  if (groups.length === 0) return;
  setColumnsVisible(
    api,
    arrangement,
    groups.map((group) => ({ group, visible }))
  );
}

export function setColumnsVisible(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  updates: ReadonlyArray<{ group: DockviewGroup; visible: boolean }>
): void {
  const snapshot = snapshotSlotColumnWidths(api, arrangement);
  let changed = false;
  for (const { group, visible } of updates) {
    if (group.api.isVisible === visible) continue;
    group.api.setVisible(visible);
    changed = true;
  }
  if (changed) {
    settleSlotColumnWidths(api, arrangement, snapshot);
  }
}

export function isEditorColumnCrushed(api: DockviewApi): boolean {
  const editorGroups = getEditorGroups(api).filter(
    (group) => group.api.isVisible
  );
  if (editorGroups.length === 0) return true;
  return editorGroups.every(
    (group) => group.api.width <= CRUSHED_EDITOR_COLUMN_WIDTH
  );
}

/**
 * The session column's live width is only meaningful while a flexible editor
 * column still exists. After the last editor tab closes, the session absorbs
 * the remainder — that expanded width must not be persisted as user intent.
 */
export function shouldPersistSessionColumnWidth(api: DockviewApi): boolean {
  return !isEditorColumnCrushed(api);
}

function defaultDockColumnWidth(gridWidth: number): number {
  return Math.max(MIN_LEFT_PANEL_WIDTH, Math.round(gridWidth * 0.1));
}

function intendedDockColumnWidth(
  gridWidth: number,
  currentWidth: number,
  preferredWidth?: number
): number {
  if (preferredWidth && preferredWidth >= MIN_LEFT_PANEL_WIDTH) {
    return preferredWidth;
  }

  const defaultWidth = defaultDockColumnWidth(gridWidth);
  const maxReasonableWidth = Math.max(defaultWidth * 2, gridWidth * 0.2);
  if (currentWidth > maxReasonableWidth) {
    return defaultWidth;
  }

  return Math.max(MIN_LEFT_PANEL_WIDTH, currentWidth);
}

export function preserveLeftDockGroupWidths<T>(
  api: DockviewApi,
  run: () => T
): T {
  const saved = [
    ...listLeftShellNavGroups(api.groups),
    ...listRightShellNavGroups(api.groups),
  ].flatMap((group) =>
    group.api.isVisible && group.api.width > 0
      ? [{ group, width: group.api.width }]
      : []
  );
  const result = run();
  if (saved.length > 0) {
    settleDockviewGroupWidths(saved);
  }
  return result;
}

/**
 * Re-apply dock and session column widths so the workspace editor absorbs
 * remaining space. Call after recreating a missing editor group: Dockview
 * otherwise seeds the new group at its 100px minimum, and the extra width
 * leaks into a side column.
 */
export function restoreFlexibleEditorColumn(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  sessionWidth?: number,
  dockWidth?: number
): void {
  if (slotOfZone(arrangement, 'workspace') !== 'center') return;

  const leftGroup = getLeftGroup(api);
  const rightGroup = getRightGroup(api);
  const editorGroups = getEditorGroups(api).filter(
    (group) => group.api.isVisible
  );
  const editorGroup = editorGroups[0];
  if (editorGroups.length !== 1 || !editorGroup) {
    return;
  }

  const dockIsSide = isSideColumn(slotOfZone(arrangement, 'dock'));
  const leftNavGroups = dockIsSide
    ? listLeftShellNavGroups(api.groups).filter((group) => group.api.isVisible)
    : [];
  const rightSessionIsSide =
    !!rightGroup?.api.isVisible &&
    isSideColumn(slotOfZone(arrangement, 'session'));
  const rightNavGroups = listRightShellNavGroups(api.groups).filter(
    (group) => group.api.isVisible
  );

  if (
    leftNavGroups.length === 0 &&
    !rightSessionIsSide &&
    rightNavGroups.length === 0
  ) {
    return;
  }

  const gridWidth = api.width;
  const leftNavTargets = leftNavGroups.map((group) => ({
    group,
    width: intendedDockColumnWidth(
      gridWidth,
      group.api.width,
      group === leftGroup ? dockWidth : group.api.width
    ),
  }));
  const nextDockWidth = leftNavTargets.reduce(
    (sum, item) => sum + item.width,
    0
  );
  const rightNavTargets = rightNavGroups.map((group) => ({
    group,
    width: intendedDockColumnWidth(gridWidth, group.api.width, group.api.width),
  }));
  const rightNavWidth = rightNavTargets.reduce(
    (sum, item) => sum + item.width,
    0
  );
  const intendedSession = Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    sessionWidth && sessionWidth > 0
      ? sessionWidth
      : DEFAULT_SESSION_PANEL_WIDTH
  );
  const maxSession = Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    gridWidth - nextDockWidth - rightNavWidth - MIN_EDITOR_COLUMN_WIDTH
  );
  const nextSessionWidth = rightSessionIsSide
    ? Math.min(intendedSession, maxSession)
    : 0;
  const nextEditorWidth = Math.max(
    MIN_EDITOR_COLUMN_WIDTH,
    gridWidth - nextDockWidth - rightNavWidth - nextSessionWidth
  );

  const targets: Array<{ group: DockviewGroup; width: number }> = [
    { group: editorGroup, width: nextEditorWidth },
  ];
  if (rightSessionIsSide && rightGroup) {
    targets.push({ group: rightGroup, width: nextSessionWidth });
  }
  for (const item of leftNavTargets) {
    targets.push(item);
  }
  for (const item of rightNavTargets) {
    targets.push(item);
  }

  settleDockviewGroupWidths(targets);
}

/**
 * Show the editor column at its flexible width before the first terminal tab
 * is added. A hidden anchor is still crushed, so width is restored only after
 * the group is visible.
 */
export function revealEditorColumnForTerminal(
  api: DockviewApi,
  options: EnsureWelcomeEditorGroupOptions
): DockviewGroup | undefined {
  const group = ensureWelcomeEditorGroup(api, options);
  if (!group) return undefined;
  if (!group.api.isVisible) {
    group.api.setVisible(true);
  }
  if (isEditorColumnCrushed(api)) {
    restoreFlexibleEditorColumn(
      api,
      options.arrangement,
      options.sessionWidth,
      options.dockWidth
    );
  }
  return group;
}

/**
 * After the last editor tab closes, keep a hidden editor group as an anchor
 * and give the leftover width to the remaining Zone B column(s) without
 * disturbing Zone A widths.
 */
export function dismissEmptyEditorColumn(
  api: DockviewApi,
  options: EnsureWelcomeEditorGroupOptions
): DockviewGroup | undefined {
  const preSnapshot = snapshotSlotColumnWidths(
    api,
    options.arrangement,
    options.dockWidth
  );
  const group = ensureWelcomeEditorGroupInternal(api, options, false);
  if (group) {
    if (group.api.isVisible) {
      group.api.setVisible(false);
    }
    settleSlotColumnWidths(api, options.arrangement, {
      ...preSnapshot,
      centerVisible: true,
    });
  }
  return group;
}

function ensureWelcomeEditorGroupInternal(
  api: DockviewApi,
  options: EnsureWelcomeEditorGroupOptions,
  restoreWidth: boolean
): DockviewGroup | undefined {
  const editorGroups = getEditorGroups(api);
  if (editorGroups.length > 0) {
    const existing = editorGroups[0];
    if (
      existing &&
      existing.panels.length === 0 &&
      !api.getPanel(PANEL_IDS.WELCOME)
    ) {
      api.addPanel({
        id: PANEL_IDS.WELCOME,
        component: PANEL_IDS.WELCOME,
        title: builtinPanelTitle(PANEL_IDS.WELCOME),
        position: { referenceGroup: existing, direction: 'within' },
        inactive: true,
      });
    }
    if (restoreWidth && isEditorColumnCrushed(api)) {
      restoreFlexibleEditorColumn(
        api,
        options.arrangement,
        options.sessionWidth,
        options.dockWidth
      );
    }
    return existing;
  }

  const existingWelcome = api.getPanel(PANEL_IDS.WELCOME);
  if (existingWelcome) {
    if (restoreWidth && isEditorColumnCrushed(api)) {
      restoreFlexibleEditorColumn(
        api,
        options.arrangement,
        options.sessionWidth,
        options.dockWidth
      );
    }
    return existingWelcome.group;
  }

  const bottomGroup = getBottomGroup(api);
  const bottomReferencePanel = bottomGroup?.panels[0];
  const leftGroup = getLeftGroup(api);
  const rightGroup = getRightGroup(api);
  const referencePanel =
    bottomReferencePanel ??
    leftGroup?.panels[0] ??
    api.panels.find(
      (panel) => !BOTTOM_PANEL_IDS.has(panel.id) && !isSessionPanelId(panel.id)
    );

  const leftWidth =
    leftGroup?.api.isVisible &&
    isSideColumn(slotOfZone(options.arrangement, 'dock'))
      ? intendedDockColumnWidth(
          api.width,
          leftGroup.api.width,
          options.dockWidth
        )
      : 0;
  const intendedSession =
    rightGroup?.api.isVisible &&
    isSideColumn(slotOfZone(options.arrangement, 'session'))
      ? Math.max(
          MIN_RIGHT_PANEL_WIDTH,
          options.sessionWidth && options.sessionWidth > 0
            ? options.sessionWidth
            : DEFAULT_SESSION_PANEL_WIDTH
        )
      : 0;
  const initialWidth = Math.max(
    MIN_EDITOR_COLUMN_WIDTH,
    api.width - leftWidth - intendedSession
  );

  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: builtinPanelTitle(PANEL_IDS.WELCOME),
    initialWidth,
    ...(referencePanel
      ? {
          position: {
            referencePanel,
            direction: bottomReferencePanel
              ? ('above' as const)
              : leftGroup
                ? ('right' as const)
                : ('within' as const),
          },
        }
      : {}),
    inactive: true,
  });

  assignDockviewGroupIdAndRole(
    api,
    welcomePanel.group,
    getNextEditorGroupId(api),
    'editor'
  );
  if (restoreWidth) {
    restoreFlexibleEditorColumn(
      api,
      options.arrangement,
      options.sessionWidth,
      options.dockWidth
    );
  }
  return welcomePanel.group;
}

export function ensureWelcomeEditorGroup(
  api: DockviewApi,
  options: EnsureWelcomeEditorGroupOptions
): DockviewGroup | undefined {
  return ensureWelcomeEditorGroupInternal(api, options, true);
}
