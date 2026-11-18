export const QUIET_HISTORY_IMPORT_KEY = 'dimo:history-import-quiet';
export const QUIET_HISTORY_IMPORT_EVENT = 'dimo:history-import-quiet';
/** Keep the status icon after the job finishes so the result can still be opened. */
export const QUIET_HISTORY_IMPORT_HOLD_MS = 10 * 60 * 1000;

export type QuietHistoryImportRecord = {
  armedAt: number;
  completedAt: number | null;
};

function write(record: QuietHistoryImportRecord) {
  sessionStorage.setItem(QUIET_HISTORY_IMPORT_KEY, JSON.stringify(record));
  window.dispatchEvent(new Event(QUIET_HISTORY_IMPORT_EVENT));
}

export function readQuietHistoryImport(): QuietHistoryImportRecord | null {
  try {
    const raw = sessionStorage.getItem(QUIET_HISTORY_IMPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuietHistoryImportRecord>;
    if (typeof parsed.armedAt !== 'number') return null;
    return {
      armedAt: parsed.armedAt,
      completedAt:
        typeof parsed.completedAt === 'number' ? parsed.completedAt : null,
    };
  } catch {
    return null;
  }
}

export function armQuietHistoryImport(
  now = Date.now()
): QuietHistoryImportRecord {
  const current = readQuietHistoryImport();
  if (current && current.completedAt == null) return current;
  const next = { armedAt: now, completedAt: null };
  write(next);
  return next;
}

/** Stamp the finish time once. Later calls keep the original 10-minute window. */
export function noteQuietHistoryImportFinished(
  now = Date.now()
): QuietHistoryImportRecord | null {
  const current = readQuietHistoryImport();
  if (!current || current.completedAt != null) return current;
  const next = { ...current, completedAt: now };
  write(next);
  return next;
}

export function clearQuietHistoryImport() {
  sessionStorage.removeItem(QUIET_HISTORY_IMPORT_KEY);
  window.dispatchEvent(new Event(QUIET_HISTORY_IMPORT_EVENT));
}

export function quietHistoryImportVisible(
  record: QuietHistoryImportRecord | null,
  status: 'idle' | 'running' | 'completed' | 'failed',
  now: number
): boolean {
  if (!record) return false;
  if (status === 'running' || record.completedAt == null) return true;
  return now - record.completedAt < QUIET_HISTORY_IMPORT_HOLD_MS;
}
