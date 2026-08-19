import { configApi, type AppReleaseStatus } from '@/lib/api';

import { resolveAppUpdate } from './resolve';
import { clearLastCheck, readLastCheck, writeLastCheck } from './storage';
import type {
  AppUpdateSnapshot,
  GitHubReleaseCheck,
  SignedFeedUpdate,
} from './types';

export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 15_000;
const APP_UPDATE_EVENT = 'vibex:app-update-checked';

let inFlight: Promise<AppUpdateSnapshot> | null = null;

function toGitHubCheck(status: AppReleaseStatus): GitHubReleaseCheck {
  return {
    current_version: status.current_version,
    latest_version: status.latest_version,
    update_available: status.update_available,
    release_url: status.release_url,
    repository: status.repository,
    checked: status.checked,
    error: status.error,
    body: status.body ?? null,
    published_at: status.published_at ?? null,
    checked_at: status.checked_at ?? new Date().toISOString(),
  };
}

async function getCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '';
  }
}

async function checkSignedFeed(): Promise<SignedFeedUpdate | null> {
  if (import.meta.env.DEV) return null;

  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: MANIFEST_TIMEOUT_MS });
  if (!update) return null;

  try {
    return {
      version: update.version,
      body: update.body ?? '',
      date: update.date ?? null,
    };
  } finally {
    try {
      await update.close();
    } catch {
      // One leaked resource slot is better than losing the check result.
    }
  }
}

async function checkGitHubRelease(): Promise<GitHubReleaseCheck> {
  return toGitHubCheck(await configApi.checkAppRelease());
}

function snapshotFromCache(): AppUpdateSnapshot | null {
  const cached = readLastCheck();
  if (!cached) return null;
  return {
    currentVersion: cached.currentVersion,
    update: cached.update,
    lastCheckedAt: cached.at,
    checked: true,
    error: null,
  };
}

function persist(snapshot: AppUpdateSnapshot): void {
  writeLastCheck({
    at: snapshot.lastCheckedAt,
    currentVersion: snapshot.currentVersion,
    update: snapshot.update,
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(APP_UPDATE_EVENT, { detail: snapshot })
    );
  }
}

export function readCachedAppUpdate(): AppUpdateSnapshot | null {
  return snapshotFromCache();
}

export function subscribeAppUpdate(
  listener: (snapshot: AppUpdateSnapshot) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onCustom = (event: Event) => {
    listener((event as CustomEvent<AppUpdateSnapshot>).detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== 'vibex.appUpdate.lastCheck') {
      return;
    }
    const cached = snapshotFromCache();
    if (cached) listener(cached);
  };

  window.addEventListener(APP_UPDATE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(APP_UPDATE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export async function checkAppUpdate(options?: {
  force?: boolean;
}): Promise<AppUpdateSnapshot> {
  if (inFlight) return inFlight;

  const force = options?.force === true;
  if (!force) {
    const cached = readLastCheck();
    if (cached && Date.now() - cached.at < CHECK_TTL_MS) {
      const currentVersion = await getCurrentVersion().catch(() => '');
      if (
        !currentVersion ||
        !cached.currentVersion ||
        currentVersion === cached.currentVersion
      ) {
        return {
          currentVersion: currentVersion || cached.currentVersion,
          update: cached.update,
          lastCheckedAt: cached.at,
          checked: true,
          error: null,
        };
      }
      clearLastCheck();
    }
  }

  inFlight = (async () => {
    const snapshot = await resolveAppUpdate({
      getCurrentVersion,
      checkSignedFeed,
      checkGitHubRelease,
      now: () => Date.now(),
    });
    persist(snapshot);
    return snapshot;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export async function installSignedUpdate(
  onProgress?: (percent: number) => void
): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: MANIFEST_TIMEOUT_MS });
  if (!update) {
    throw new Error('No signed update is available to install');
  }

  try {
    let total = 0;
    let downloaded = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
        onProgress?.(0);
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        onProgress?.(total > 0 ? Math.round((downloaded / total) * 100) : 0);
      } else if (event.event === 'Finished') {
        onProgress?.(100);
      }
    });
    clearLastCheck();
  } finally {
    try {
      await update.close();
    } catch {
      // ignore
    }
  }
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
