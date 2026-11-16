import type { DockviewApi } from 'dockview-react';
import { EDITOR_GROUP_PREFIX, GROUP_IDS } from '@/stores/useLayoutStore';
import {
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isRightShellNavGroup,
  isSessionGroup,
  LEFT_GROUP_PREFIX,
  RIGHT_GROUP_PREFIX,
} from '@/utils/dockviewGroupPolicy';
import { gridLocationFromElement } from '@/utils/dockviewEditorSplit';
import { settleDockviewGroupWidths } from '@/utils/dockviewStartupSizing';

type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;

export type ColumnKind = 'shellNav' | 'editor' | 'session' | 'bottom' | 'other';

export interface CapturedGroupGeometry {
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

export interface HorizontalBranchSummary {
  branchIndex: number;
  kind: ColumnKind;
  reps: Array<{ group: DockviewGroup; width: number }>;
}

interface BranchGeometrySummary {
  branchIndex: number;
  kind: ColumnKind;
  side: 'left' | 'right';
  width: number;
  reps: Array<{ group: DockviewGroup; width: number }>;
  groups: Set<DockviewGroup>;
}

export interface RebalanceAfterAddOrMoveOptions {
  subjectGroup?: DockviewGroup;
  donorGroup?: DockviewGroup;
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

export function captureZoneColumnWidths(
  api: DockviewApi
): CapturedGroupGeometry[] {
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

function summarizeBranchRow(
  entries: readonly CapturedGroupGeometry[],
  depth: number
): Array<{ group: DockviewGroup; width: number }> {
  const directLeaf = entries.find(
    (item) => item.location.length === depth + 1
  );
  if (directLeaf) {
    return [{ group: directLeaf.group, width: directLeaf.width }];
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
  if (verticalLeaf) {
    return [{ group: verticalLeaf.group, width: verticalLeaf.width }];
  }
  return rowEntries
    .filter((item) => item.location.length === depth + 3)
    .sort((a, b) => a.index - b.index)
    .map((item) => ({ group: item.group, width: item.width }));
}

export function summarizeHorizontalBranches(
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

    const reps = summarizeBranchRow(entries, depth);
    if (reps.length > 0) {
      summaries.push({ branchIndex, kind, reps });
    }
  }

  return summaries;
}

function summarizeHorizontalBranchGeometries(
  entries: readonly CapturedGroupGeometry[],
  hPrefix: readonly number[]
): BranchGeometrySummary[] {
  const depth = hPrefix.length;
  const byBranch = new Map<number, CapturedGroupGeometry[]>();

  for (const entry of entries) {
    if (!hasLocationPrefix(entry.location, hPrefix)) continue;
    if (entry.location.length <= depth) continue;
    const branchIndex = entry.location[depth]!;
    const list = byBranch.get(branchIndex) ?? [];
    list.push(entry);
    byBranch.set(branchIndex, list);
  }

  const summaries: BranchGeometrySummary[] = [];
  const sortedBranchIndices = [...byBranch.keys()].sort((a, b) => a - b);

  for (const branchIndex of sortedBranchIndices) {
    const branchEntries = byBranch.get(branchIndex)!;
    const kind: ColumnKind = branchEntries.some(
      (item) => item.kind === 'shellNav'
    )
      ? 'shellNav'
      : branchEntries.some((item) => item.kind === 'editor')
        ? 'editor'
        : branchEntries.some((item) => item.kind === 'session')
          ? 'session'
          : branchEntries.some((item) => item.kind === 'bottom')
            ? 'bottom'
            : 'other';
    const side: 'left' | 'right' = branchEntries.some((item) =>
      isRightShellNavGroup(item.group)
    )
      ? 'right'
      : 'left';
    const reps = summarizeBranchRow(branchEntries, depth);
    if (reps.length > 0) {
      summaries.push({
        branchIndex,
        kind,
        side,
        width: reps.reduce((sum, rep) => sum + rep.width, 0),
        reps,
        groups: new Set(branchEntries.map((item) => item.group)),
      });
    }
  }

  return summaries;
}

function groupMinimumWidth(group: DockviewGroup): number {
  const min = (group as { minimumWidth?: number }).minimumWidth;
  return typeof min === 'number' && Number.isFinite(min) && min > 0
    ? min
    : 100;
}

function branchMinimumWidth(branch: BranchGeometrySummary): number {
  return branch.reps.reduce(
    (sum, rep) => sum + groupMinimumWidth(rep.group),
    0
  );
}

function isSameZoneSide(
  a: BranchGeometrySummary,
  b: BranchGeometrySummary
): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'shellNav' ? a.side === b.side : true;
}

function borrowDeficitFromBranches(
  branches: readonly BranchGeometrySummary[],
  targets: Map<BranchGeometrySummary, number>,
  deficit: number
): number {
  let remaining = deficit;
  if (remaining <= 0) return 0;

  // Donate from widest slack branches first so narrow siblings stay stable.
  const candidates = branches
    .map((branch) => ({
      branch,
      slack: Math.max(0, (targets.get(branch) ?? 0) - branchMinimumWidth(branch)),
    }))
    .filter((item) => item.slack > 0)
    .sort((a, b) => b.slack - a.slack);

  for (const item of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, item.slack);
    targets.set(item.branch, (targets.get(item.branch) ?? 0) - take);
    remaining -= take;
  }

  return remaining;
}

function rebalanceHorizontalSplitAtPrefix(
  api: DockviewApi,
  snapshot: readonly CapturedGroupGeometry[],
  live: readonly CapturedGroupGeometry[],
  hPrefix: readonly number[],
  options: RebalanceAfterAddOrMoveOptions
): boolean {
  const snapBranches = summarizeHorizontalBranchGeometries(snapshot, hPrefix);
  if (snapBranches.length === 0) {
    return false;
  }

  const liveBranches = summarizeHorizontalBranchGeometries(live, hPrefix);
  if (liveBranches.length === 0) {
    return false;
  }

  const matchedSnap = new Map<BranchGeometrySummary, BranchGeometrySummary>();
  const matchedLive = new Map<BranchGeometrySummary, BranchGeometrySummary>();

  for (const sb of snapBranches) {
    const candidates = liveBranches.filter((lb) => {
      if (matchedSnap.has(lb)) return false;
      for (const group of sb.groups) {
        if (lb.groups.has(group)) return true;
      }
      return false;
    });
    if (candidates.length === 0) continue;

    // If a vertical stack split out into a horizontal column, the branch that
    // retained the non-subject group owns the pre-split branch geometry.
    const preferred =
      candidates.find((lb) => {
        for (const group of sb.groups) {
          if (group !== options.subjectGroup && lb.groups.has(group)) {
            return true;
          }
        }
        return false;
      }) ?? candidates[0]!;
    matchedSnap.set(preferred, sb);
    matchedLive.set(sb, preferred);
  }

  const newLiveBranches = liveBranches.filter((lb) => !matchedSnap.has(lb));
  const orphanedSnapBranches = snapBranches.filter(
    (sb) => !matchedLive.has(sb)
  );

  // If no horizontal branch was added or removed, preserve current widths.
  if (newLiveBranches.length === 0 && orphanedSnapBranches.length === 0) {
    return false;
  }

  const targets = new Map<BranchGeometrySummary, number>();
  for (const lb of liveBranches) {
    const sb = matchedSnap.get(lb);
    targets.set(lb, sb ? sb.width : 0);
  }

  const donorMatchedBranches: BranchGeometrySummary[] = [];

  if (newLiveBranches.length === 0 && orphanedSnapBranches.length > 0) {
    const orphanedZoneB = orphanedSnapBranches.filter((sb) =>
      isZoneBKind(sb.kind)
    );
    if (orphanedZoneB.length === 0) {
      return false;
    }
    const freedWidth = orphanedZoneB.reduce((sum, sb) => sum + sb.width, 0);
    const primaryKind = orphanedZoneB[0]!.kind;
    const sameKindSurvivors = liveBranches.filter(
      (lb) => lb.kind === primaryKind
    );
    const recipients =
      sameKindSurvivors.length > 0
        ? sameKindSurvivors
        : liveBranches.filter((lb) => isZoneBKind(lb.kind));
    if (recipients.length === 0) {
      return false;
    }
    const share = Math.floor(freedWidth / recipients.length);
    let remainder = freedWidth - share * recipients.length;
    for (const lb of recipients) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      targets.set(lb, (targets.get(lb) ?? 0) + share + extra);
    }
  } else if (newLiveBranches.length > 0) {
    // If only shellNav branches were added and no Zone B column was perturbed,
    // let dedicated shell-nav placement helpers size them without fighting.
    const onlyShellNavChanged =
      newLiveBranches.every((lb) => lb.kind === 'shellNav') &&
      liveBranches.every(
        (lb) =>
          lb.kind === 'shellNav' ||
          (matchedSnap.has(lb) &&
            Math.abs(lb.width - matchedSnap.get(lb)!.width) <= 1)
      );
    if (onlyShellNavChanged && !options.donorGroup) {
      return false;
    }

    for (const newBranch of newLiveBranches) {
      const newIdx = liveBranches.indexOf(newBranch);
      const sameKindMatched = liveBranches.filter(
        (lb) => matchedSnap.has(lb) && isSameZoneSide(lb, newBranch)
      );

      if (sameKindMatched.length === 0) {
        // Brand-new zone column (e.g. creating group-left or group-right):
        // honor its initial width and absorb from editor/Zone B columns,
        // keeping existing shellNav and session columns untouched.
        const needed = Math.max(
          branchMinimumWidth(newBranch),
          newBranch.width
        );
        targets.set(newBranch, needed);
        let remaining = needed;
        remaining = borrowDeficitFromBranches(
          liveBranches.filter(
            (lb) => lb !== newBranch && matchedSnap.has(lb) && lb.kind === 'editor'
          ),
          targets,
          remaining
        );
        remaining = borrowDeficitFromBranches(
          liveBranches.filter(
            (lb) =>
              lb !== newBranch &&
              matchedSnap.has(lb) &&
              lb.kind !== 'editor' &&
              isZoneBKind(lb.kind)
          ),
          targets,
          remaining
        );
        if (remaining > 0) {
          targets.set(
            newBranch,
            Math.max(branchMinimumWidth(newBranch), needed - remaining)
          );
        }
        continue;
      }

      // Splitting an existing zone column: split only the donor column 50/50
      // (borrowing from same-kind/Zone B siblings only if donor would violate
      // minimumWidth), keeping Zone A and unrelated Zone B columns locked.
      const donorFromOption = options.donorGroup
        ? sameKindMatched.find((lb) => lb.groups.has(options.donorGroup!))
        : undefined;
      const leftNeighbor =
        newIdx > 0 ? liveBranches[newIdx - 1] : undefined;
      const rightNeighbor =
        newIdx + 1 < liveBranches.length
          ? liveBranches[newIdx + 1]
          : undefined;
      const adjacentDonor =
        (leftNeighbor && sameKindMatched.includes(leftNeighbor)
          ? leftNeighbor
          : undefined) ??
        (rightNeighbor && sameKindMatched.includes(rightNeighbor)
          ? rightNeighbor
          : undefined);
      const donorBranch =
        donorFromOption ?? adjacentDonor ?? sameKindMatched[0]!;
      donorMatchedBranches.push(donorBranch);

      const donorWidth = targets.get(donorBranch) ?? donorBranch.width;
      const minDonor = branchMinimumWidth(donorBranch);
      const minNew = branchMinimumWidth(newBranch);
      const minRequired = minDonor + minNew;

      if (donorWidth >= minRequired) {
        const newWidth = Math.max(minNew, Math.floor(donorWidth / 2));
        let nextDonorWidth = donorWidth - newWidth;
        let finalNewWidth = newWidth;
        if (nextDonorWidth < minDonor) {
          nextDonorWidth = minDonor;
          finalNewWidth = donorWidth - minDonor;
        }
        targets.set(donorBranch, nextDonorWidth);
        targets.set(newBranch, finalNewWidth);
      } else {
        let deficit = minRequired - donorWidth;
        targets.set(donorBranch, minDonor);
        targets.set(newBranch, minNew);
        deficit = borrowDeficitFromBranches(
          sameKindMatched.filter((lb) => lb !== donorBranch),
          targets,
          deficit
        );
        if (deficit > 0 && newBranch.kind !== 'shellNav') {
          deficit = borrowDeficitFromBranches(
            liveBranches.filter(
              (lb) =>
                lb !== newBranch &&
                matchedSnap.has(lb) &&
                isZoneBKind(lb.kind) &&
                !sameKindMatched.includes(lb)
            ),
            targets,
            deficit
          );
        }
        if (deficit > 0) {
          borrowDeficitFromBranches(
            liveBranches.filter(
              (lb) =>
                lb !== newBranch &&
                lb !== donorBranch &&
                matchedSnap.has(lb) &&
                lb.kind === 'shellNav'
            ),
            targets,
            deficit
          );
        }
      }
    }
  }

  // Reconcile any rounding/margin delta against flexible Zone B columns first.
  const liveTotalWidth = liveBranches.reduce((sum, lb) => sum + lb.width, 0);
  const targetTotalWidth = [...targets.values()].reduce(
    (sum, width) => sum + width,
    0
  );
  let delta = Math.round(liveTotalWidth - targetTotalWidth);
  if (delta !== 0) {
    const adjustOrder = [
      ...newLiveBranches.filter((lb) => lb.kind !== 'shellNav'),
      ...donorMatchedBranches.filter((lb) => lb.kind !== 'shellNav'),
      ...liveBranches.filter((lb) => lb.kind === 'editor'),
      ...liveBranches.filter(
        (lb) => isZoneBKind(lb.kind) && lb.kind !== 'editor'
      ),
      ...liveBranches.filter((lb) => lb.kind === 'shellNav'),
    ];
    const seen = new Set<BranchGeometrySummary>();
    for (const lb of adjustOrder) {
      if (delta === 0) break;
      if (seen.has(lb)) continue;
      seen.add(lb);
      const current = targets.get(lb) ?? 0;
      if (delta > 0) {
        targets.set(lb, current + delta);
        delta = 0;
      } else {
        const slack = Math.max(0, current - branchMinimumWidth(lb));
        const take = Math.min(-delta, slack);
        if (take > 0) {
          targets.set(lb, current - take);
          delta += take;
        }
      }
    }
  }

  const settleTargets: Array<{ group: DockviewGroup; width: number }> = [];
  const seenGroups = new Set<DockviewGroup>();
  const pushTarget = (group: DockviewGroup, width: number) => {
    if (seenGroups.has(group) || !(width > 0)) return;
    seenGroups.add(group);
    settleTargets.push({ group, width });
  };

  if (hPrefix.length > 0) {
    const rootSnapBranches = summarizeHorizontalBranchGeometries(
      snapshot.filter((entry) => isLiveVisibleGroup(api, entry.group)),
      []
    );
    const activeRootBranch = hPrefix[0]!;
    for (const rootBranch of rootSnapBranches) {
      if (rootBranch.branchIndex === activeRootBranch) continue;
      for (const rep of rootBranch.reps) {
        pushTarget(rep.group, rep.width);
      }
    }
  }

  for (const lb of liveBranches) {
    const branchTarget = targets.get(lb) ?? lb.width;
    if (lb.reps.length === 1) {
      pushTarget(lb.reps[0]!.group, branchTarget);
      continue;
    }

    const repTotal = lb.reps.reduce((sum, rep) => sum + rep.width, 0);
    if (repTotal <= 0) continue;
    let allocated = 0;
    for (let index = 0; index < lb.reps.length; index += 1) {
      const rep = lb.reps[index]!;
      const width =
        index === lb.reps.length - 1
          ? Math.max(groupMinimumWidth(rep.group), branchTarget - allocated)
          : Math.max(
              groupMinimumWidth(rep.group),
              Math.round((rep.width / repTotal) * branchTarget)
            );
      allocated += width;
      pushTarget(rep.group, width);
    }
  }

  if (settleTargets.length === 0) {
    return false;
  }

  settleDockviewGroupWidths(settleTargets);
  return true;
}

/**
 * Dockview's `addGroup` / `moveGroupOrPanel` without an explicit width calls
 * `Sizing.Distribute`, which equalizes every flexible sibling in the same
 * Splitview — including Zone A shell-nav and unaffected Zone B columns.
 * Restore pre-split Zone A and unaffected column widths while splitting only
 * the target column (or absorbing freed width on vertical merge).
 */
export function rebalanceZoneColumnsAfterGroupAdded(
  api: DockviewApi,
  snapshot: readonly CapturedGroupGeometry[],
  addedGroup: DockviewGroup,
  options?: { donorGroup?: DockviewGroup }
): void {
  rebalanceZoneColumnsAfterAddOrMove(api, snapshot, {
    subjectGroup: addedGroup,
    donorGroup: options?.donorGroup,
  });
}

function rebalanceZoneColumnsAfterAddOrMove(
  api: DockviewApi,
  snapshot: readonly CapturedGroupGeometry[],
  options: RebalanceAfterAddOrMoveOptions
): void {
  if (snapshot.length === 0) return;

  let live = captureZoneColumnWidths(api);
  if (live.length === 0) return;

  const subjectLive = options.subjectGroup
    ? live.find((entry) => entry.group === options.subjectGroup)
    : undefined;
  const candidatePrefixes: number[][] = [[]];
  if (
    subjectLive &&
    subjectLive.sharesWidth &&
    subjectLive.location.length > 1
  ) {
    candidatePrefixes.push(subjectLive.location.slice(0, -1));
  }

  for (const hPrefix of candidatePrefixes) {
    const changed = rebalanceHorizontalSplitAtPrefix(
      api,
      snapshot,
      live,
      hPrefix,
      options
    );
    if (changed && candidatePrefixes.length > 1) {
      const refreshed = captureZoneColumnWidths(api);
      if (refreshed.length > 0) {
        live = refreshed;
      }
    }
  }
}

function isUnassignedDockviewGroupId(id: string): boolean {
  return (
    id !== GROUP_IDS.LEFT &&
    !id.startsWith(LEFT_GROUP_PREFIX) &&
    !id.startsWith(EDITOR_GROUP_PREFIX) &&
    id !== GROUP_IDS.RIGHT &&
    !id.startsWith(RIGHT_GROUP_PREFIX) &&
    id !== GROUP_IDS.BOTTOM
  );
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
  let clearDropHintQueued = false;
  let disposed = false;
  let pendingDropHint: {
    targetGroup?: DockviewGroup;
    position?: string;
  } | null = null;
  const groupDisposables = new Map<
    DockviewGroup,
    Array<{ dispose(): void }>
  >();

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

  const scheduleClearDropHint = () => {
    if (clearDropHintQueued || disposed) return;
    clearDropHintQueued = true;
    queueMicrotask(() => {
      clearDropHintQueued = false;
      pendingDropHint = null;
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

  const willDropDisposable = api.onWillDrop?.((event) => {
    const live = captureZoneColumnWidths(api);
    if (live.length > 0) {
      snapshot = live;
    }
    pendingDropHint = {
      targetGroup: event.group,
      position: event.position,
    };
    scheduleClearDropHint();
  });

  const addGroupDisposable = api.onDidAddGroup((group) => {
    bindGroupListeners(group);
    const shouldRebalance = options?.shouldRebalance?.() ?? true;
    const isProvisionalEmptyGroup =
      group.panels.length === 0 && isUnassignedDockviewGroupId(group.id);
    if (shouldRebalance) {
      const donorGroup =
        pendingDropHint && pendingDropHint.position !== 'center'
          ? pendingDropHint.targetGroup
          : undefined;
      rebalanceZoneColumnsAfterAddOrMove(api, snapshot, {
        subjectGroup: group,
        donorGroup,
      });
      if (!isProvisionalEmptyGroup) {
        const next = captureZoneColumnWidths(api);
        if (next.length > 0) {
          snapshot = next;
        }
      }
    }
    scheduleSnapshotRefresh();
  });

  const movePanelDisposable = api.onDidMovePanel?.(({ panel, from }) => {
    const shouldRebalance = options?.shouldRebalance?.() ?? true;
    if (shouldRebalance && pendingDropHint?.position !== 'center') {
      const donorGroup =
        pendingDropHint?.targetGroup ??
        (panel.group !== from ? from : undefined);
      rebalanceZoneColumnsAfterAddOrMove(api, snapshot, {
        subjectGroup: panel.group,
        donorGroup,
      });
    }
    pendingDropHint = null;
    const next = captureZoneColumnWidths(api);
    if (next.length > 0) {
      snapshot = next;
    }
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
      willDropDisposable?.dispose();
      addGroupDisposable.dispose();
      movePanelDisposable?.dispose();
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
