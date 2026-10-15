import type { Diff, DiffChangeKind } from 'shared/types';

export function streamContentsAreUsable(diff: Diff): boolean {
  const requiresOld = diff.change !== 'added';
  const requiresNew = diff.change !== 'deleted';
  if (diff.contentOmitted) return false;
  if (requiresOld && diff.oldContent == null) return false;
  if (requiresNew && diff.newContent == null) return false;
  const hasStats = (diff.additions ?? 0) + (diff.deletions ?? 0) > 0;
  if (
    hasStats &&
    (diff.oldContent ?? '') === '' &&
    (diff.newContent ?? '') === '' &&
    diff.change !== 'added' &&
    diff.change !== 'deleted'
  ) {
    return false;
  }
  return true;
}

export function headerChangeCounts(
  diff: Pick<Diff, 'additions' | 'deletions'>,
  generated: { additions: number; deletions: number } | null
): { additions: number; deletions: number } {
  return {
    additions: diff.additions ?? generated?.additions ?? 0,
    deletions: diff.deletions ?? generated?.deletions ?? 0,
  };
}

/**
 * A rebuilt diff that reports no deletions while git counted some was built
 * from the wrong base (usually HEAD instead of the merge-base). Do not show it.
 * Stream content is trusted: whitespace-ignoring diffs may legally report 0.
 */
export function generatedDiffDropsDeletions(
  authoritativeDeletions: number | null,
  generatedDeletions: number,
  usingStream: boolean
): boolean {
  return (
    !usingStream &&
    (authoritativeDeletions ?? 0) > 0 &&
    generatedDeletions === 0
  );
}

export function diffNeedsBaseSnapshot(change: DiffChangeKind): boolean {
  return change !== 'added';
}
