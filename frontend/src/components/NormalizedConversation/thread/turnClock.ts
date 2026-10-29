/** Stamps at or before this instant are placeholders, not a turn start. */
export const TURN_START_FLOOR_MS = Date.UTC(2000, 0, 1);

/** Longer than any honest live turn; absolute timestamps land above this. */
export const MAX_TURN_ELAPSED_MS = 14 * 24 * 60 * 60 * 1000;

export function plausibleTurnStartMs(
  value: string | null | undefined
): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < TURN_START_FLOOR_MS) return null;
  return ms;
}

export function liveElapsedMs(
  startedAt: string | null | undefined,
  nowMs: number,
  reportedMs?: number | null
): number | null {
  if (
    typeof reportedMs === 'number' &&
    Number.isFinite(reportedMs) &&
    reportedMs >= 0 &&
    reportedMs <= MAX_TURN_ELAPSED_MS
  ) {
    return reportedMs;
  }
  const startedAtMs = plausibleTurnStartMs(startedAt);
  if (startedAtMs === null) return null;
  const elapsed = Math.max(0, nowMs - startedAtMs);
  return elapsed <= MAX_TURN_ELAPSED_MS ? elapsed : null;
}
