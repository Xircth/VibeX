import type { AppUpdateInfo, CachedUpdateCheck } from './types';
import { normalizeMainWindowRoute } from '@/lib/paths';

export const LAST_CHECK_KEY = 'vibex.appUpdate.lastCheck';
export const DISMISSED_VERSION_KEY = 'vibex.appUpdate.dismissedVersion';
export const LAST_MAIN_ROUTE_KEY = 'vibex.appUpdate.lastMainRoute';
export const POST_UPDATE_RESTORE_KEY = 'vibex.appUpdate.postUpdateRestore';
export const POST_UPDATE_RESTORE_TTL_MS = 30 * 60 * 1000;

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

export function readDismissedVersion(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(DISMISSED_VERSION_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeDismissedVersion(version: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (version && version.length > 0) {
      window.localStorage.setItem(DISMISSED_VERSION_KEY, version);
    } else {
      window.localStorage.removeItem(DISMISSED_VERSION_KEY);
    }
  } catch {
    // ignore
  }
}

export function recordMainWindowRoute(route: string): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeMainWindowRoute(route);
  if (!normalized) return;

  try {
    window.localStorage.setItem(LAST_MAIN_ROUTE_KEY, normalized);
  } catch {
    // ignore
  }
}

export function readLastMainWindowRoute(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LAST_MAIN_ROUTE_KEY);
    return value ? normalizeMainWindowRoute(value) : null;
  } catch {
    return null;
  }
}

export function writePostUpdateRestoreRoute(
  currentRoute?: string,
  now: number = Date.now()
): void {
  if (typeof window === 'undefined') return;

  const candidate =
    currentRoute ??
    `${window.location.pathname}${window.location.search}${window.location.hash}`;

  const normalized = normalizeMainWindowRoute(candidate);
  const resolvedRoute =
    normalized && normalized !== '/' ? normalized : readLastMainWindowRoute();

  if (!resolvedRoute || resolvedRoute === '/') return;

  try {
    window.localStorage.setItem(
      POST_UPDATE_RESTORE_KEY,
      JSON.stringify({ route: resolvedRoute, at: now })
    );
  } catch {
    // ignore
  }
}

export function consumePostUpdateRestoreRoute(
  now: number = Date.now()
): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(POST_UPDATE_RESTORE_KEY);
    if (!raw) return null;
    window.localStorage.removeItem(POST_UPDATE_RESTORE_KEY);

    const parsed = JSON.parse(raw) as { route?: unknown; at?: unknown };
    if (
      typeof parsed.route !== 'string' ||
      parsed.route === '/' ||
      typeof parsed.at !== 'number' ||
      !Number.isFinite(parsed.at)
    ) {
      return null;
    }

    if (now - parsed.at > POST_UPDATE_RESTORE_TTL_MS) {
      return null;
    }

    return normalizeMainWindowRoute(parsed.route);
  } catch {
    return null;
  }
}
