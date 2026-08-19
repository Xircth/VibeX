import type { LogRecord } from '@/lib/api';

export function applyLogBatch(
  prev: LogRecord[],
  batch: LogRecord[],
  limit: number
): LogRecord[] {
  if (batch.length === 0) return prev;

  let lastSeq =
    prev.length > 0 ? prev[prev.length - 1].seq : Number.NEGATIVE_INFINITY;
  const fresh: LogRecord[] = [];
  for (const rec of batch) {
    if (rec.seq <= lastSeq) continue;
    fresh.push(rec);
    lastSeq = rec.seq;
  }
  if (fresh.length === 0) return prev;

  const next = prev.length > 0 ? prev.concat(fresh) : fresh;
  return next.length > limit ? next.slice(next.length - limit) : next;
}
