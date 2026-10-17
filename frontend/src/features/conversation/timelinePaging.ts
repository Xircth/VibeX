import type { TimelineRow } from 'shared/types';

/** Rows fetched per older-history page so each paint is incremental. */
export const TIMELINE_OLDER_PAGE_SIZE = 16;

export function nextOlderTimelinePage(
  olderCursor: string | null | undefined
): { start: number; limit: number } | null {
  if (olderCursor == null || olderCursor === '') return null;
  const end = Number(olderCursor);
  if (!Number.isFinite(end) || end <= 0) return null;
  const start = Math.max(0, end - TIMELINE_OLDER_PAGE_SIZE);
  return { start, limit: end - start };
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
  const loadedCursor = loaded ?? null;
  const incomingCursor = incoming ?? null;
  if (!hasLoadedRows) return incomingCursor;
  if (loadedCursor == null) return null;
  if (incomingCursor == null) return loadedCursor;
  const loadedIndex = Number(loadedCursor);
  const incomingIndex = Number(incomingCursor);
  if (!Number.isFinite(loadedIndex)) return incomingCursor;
  if (!Number.isFinite(incomingIndex)) return loadedCursor;
  return String(Math.min(loadedIndex, incomingIndex));
}

function revisionOf(row: TimelineRow): bigint {
  return typeof row.revision === 'bigint' ? row.revision : BigInt(row.revision);
}

/** Keep already-paged rows when the open path only sends the tail window. */
export function mergeOpenTimelineRows(
  existing: TimelineRow[],
  incoming: TimelineRow[]
): TimelineRow[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((row) => [row.row_id, row]));
  const firstRevision = revisionOf(existing[0]!);
  const older: TimelineRow[] = [];
  const newer: TimelineRow[] = [];
  for (const row of incoming) {
    const previous = byId.get(row.row_id);
    if (previous) {
      if (revisionOf(row) >= revisionOf(previous)) {
        byId.set(row.row_id, row);
      }
      continue;
    }
    if (revisionOf(row) <= firstRevision) older.push(row);
    else newer.push(row);
  }
  return [
    ...older,
    ...existing.map((row) => byId.get(row.row_id) ?? row),
    ...newer,
  ];
}
