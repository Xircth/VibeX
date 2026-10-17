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
