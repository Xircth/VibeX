import type { TimelineRow } from 'shared/types';

/** Turns fetched per older-history page. Matches the open tail of 120. */
export const TIMELINE_OLDER_PAGE_SIZE = 120;

export function nextOlderTimelinePage(
  olderCursor: string | null | undefined
): { cursor: string; limit: number } | null {
  if (olderCursor == null) return null;
  const cursor = olderCursor.trim();
  if (cursor.length === 0) return null;
  return { cursor, limit: TIMELINE_OLDER_PAGE_SIZE };
}

/**
 * Keep the more-complete paging cursor across a tail reload.
 * A null loaded cursor with rows already in memory means history is complete.
 */
export function preferLoadedOlderCursor(
  loaded: string | null | undefined,
  incoming: string | null | undefined,
  hasLoadedRows: boolean
): string | null {
  const loadedCursor =
    loaded != null && loaded.trim().length > 0 ? loaded : null;
  const incomingCursor =
    incoming != null && incoming.trim().length > 0 ? incoming : null;
  if (!hasLoadedRows) return incomingCursor;
  if (loadedCursor == null) return null;
  return loadedCursor;
}

function revisionOf(row: TimelineRow): bigint {
  return typeof row.revision === 'bigint' ? row.revision : BigInt(row.revision);
}

/**
 * Keep already-paged rows when the open path only sends the tail window.
 *
 * A row that arrives before the first shared id is older history. A row with
 * a newer revision than that anchor is a tail row that sorted too early; it
 * stays after the window instead of being prepended above earlier turns.
 */
export function mergeOpenTimelineRows(
  existing: TimelineRow[],
  incoming: TimelineRow[]
): TimelineRow[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((row) => [row.row_id, row]));
  const firstSharedIncomingIndex = incoming.findIndex((row) =>
    byId.has(row.row_id)
  );
  const firstRow = existing[0]!;
  const firstRevision = revisionOf(firstRow);
  const older: TimelineRow[] = [];
  const newer: TimelineRow[] = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const row = incoming[index]!;
    const previous = byId.get(row.row_id);
    if (previous) {
      if (revisionOf(row) >= revisionOf(previous)) {
        byId.set(row.row_id, row);
      }
      continue;
    }
    if (firstSharedIncomingIndex >= 0) {
      const anchor = incoming[firstSharedIncomingIndex]!;
      if (
        index < firstSharedIncomingIndex &&
        revisionOf(row) <= revisionOf(anchor)
      ) {
        older.push(row);
      } else {
        newer.push(row);
      }
    } else if (revisionOf(row) <= firstRevision) {
      older.push(row);
    } else {
      newer.push(row);
    }
  }
  return [
    ...older,
    ...existing.map((row) => byId.get(row.row_id) ?? row),
    ...newer,
  ];
}

export function computeAnchoredTimelineStartIndex(input: {
  totalItems: number;
  visibleTailCount: number;
  followTail: boolean;
  anchoredStartIndex: number | null;
}): number {
  const unanchored = Math.max(0, input.totalItems - input.visibleTailCount);
  if (input.followTail || input.anchoredStartIndex === null) {
    return unanchored;
  }
  return Math.min(unanchored, Math.max(0, input.anchoredStartIndex));
}
