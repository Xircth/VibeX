import type { AppUpdateInfo, CachedUpdateCheck } from './types';

export const LAST_CHECK_KEY = 'vibex.appUpdate.lastCheck';

function asUpdateInfo(value: unknown): AppUpdateInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'string' || record.version.length === 0) {
    return null;
  }

  return {
    version: record.version,
    body: typeof record.body === 'string' ? record.body : '',
    date: typeof record.date === 'string' ? record.date : null,
    releaseUrl:
      typeof record.releaseUrl === 'string' ? record.releaseUrl : null,
    canInstall: record.canInstall === true,
  };
}

export function readLastCheck(): CachedUpdateCheck | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(LAST_CHECK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.at !== 'number' ||
      !Number.isFinite(record.at) ||
      record.at <= 0
    ) {
      return null;
    }

    return {
      at: record.at,
      currentVersion:
        typeof record.currentVersion === 'string' ? record.currentVersion : '',
      update: asUpdateInfo(record.update),
    };
  } catch {
    return null;
  }
}

export function writeLastCheck(value: CachedUpdateCheck): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, JSON.stringify(value));
  } catch {
    // Private mode / quota — the next check will just refetch.
  }
}

export function clearLastCheck(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LAST_CHECK_KEY);
  } catch {
    // ignore
  }
}
