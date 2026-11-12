import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import {
  hostClientApi,
  type HostClientProfile,
  type PendingCloudDelete,
  type SyncableHostProfile,
} from '@/lib/api';
import { backendListen } from '@/lib/backendTransport';
import { isTauriClient } from '@/lib/desktopShell';
import { savedHostAddress, savedHostSource } from '@/pages/settings/savedHostAddress';

import {
  AccountError,
  HOST_BOUND_ACCOUNTS_EVENT,
  accountApi,
  resolveProfileBoundAccount,
  writeHostBoundAccount,
  type RouterOverview,
} from './account';
import {
  resolveAccountStorageKey,
  resolveLegacyAccountStorageKeys,
} from './accountHostConfigs';
import { useVibeXAccount } from './useVibeXAccount';

const PUSH_DEBOUNCE_MS = 350;
const ECHO_COOLDOWN_MS = 180;

export type AccountSavedRemoteHostSummary = {
  id: string;
  name: string;
  kind: 'ssh' | 'http';
  targetLabel: string;
  hasCredential: boolean;
  needsToken: boolean;
  connected: boolean;
  lastConnectedAt: string | null;
};

type AccountSavedHostsStoreState = {
  accountKey: string | null;
  savedHosts: AccountSavedRemoteHostSummary[];
  isSyncing: boolean;
  lastSyncedAt: string | null;
  error: string | null;
};

let storeState: AccountSavedHostsStoreState = {
  accountKey: null,
  savedHosts: [],
  isSyncing: false,
  lastSyncedAt: null,
  error: null,
};

const storeListeners = new Set<() => void>();
let syncQueue: Promise<void> = Promise.resolve();
let suppressEchoDepth = 0;
let suppressEchoUntil = 0;
const lastPushedSignatureByAccount = new Map<string, string>();

function emitStore(next: Partial<AccountSavedHostsStoreState>): void {
  storeState = { ...storeState, ...next };
  for (const listener of storeListeners) {
    listener();
  }
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getStoreSnapshot(): AccountSavedHostsStoreState {
  return storeState;
}

function runWithEchoSuppressed<T>(work: () => Promise<T>): Promise<T> {
  suppressEchoDepth += 1;
  return work().finally(() => {
    suppressEchoDepth = Math.max(0, suppressEchoDepth - 1);
    suppressEchoUntil = Date.now() + ECHO_COOLDOWN_MS;
  });
}

function isEchoSuppressed(): boolean {
  return suppressEchoDepth > 0 || Date.now() < suppressEchoUntil;
}

function enqueueSyncTask<T>(task: () => Promise<T>): Promise<T> {
  const next = syncQueue.then(task, task);
  syncQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function isPrimarySyncCoordinatorWindow(): boolean {
  try {
    const label = getCurrentWindow().label;
    return !label || label === 'main';
  } catch {
    return true;
  }
}

function formatSshTargetLabel(
  provision: Record<string, unknown> | null | undefined,
  fallbackOrigin: string
): string {
  const host = typeof provision?.host === 'string' ? provision.host.trim() : '';
  const user = typeof provision?.user === 'string' ? provision.user.trim() : '';
  const rawPort = Number(provision?.port);
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 22;
  if (host) {
    const hostPort = port === 22 ? host : `${host}:${port}`;
    return user ? `${user}@${hostPort}` : hostPort;
  }
  return savedHostAddress({ origin: fallbackOrigin, provision });
}

export function summarizeHostClientProfile(
  profile: HostClientProfile
): AccountSavedRemoteHostSummary {
  const isSsh = savedHostSource(profile.provision_kind) === 'ssh';
  return {
    id: profile.id,
    name: profile.name || savedHostAddress(profile),
    kind: isSsh ? 'ssh' : 'http',
    targetLabel: isSsh
      ? formatSshTargetLabel(profile.provision, profile.origin)
      : savedHostAddress(profile),
    hasCredential: Boolean(profile.has_credential && !profile.needs_token),
    needsToken: Boolean(profile.needs_token),
    connected: Boolean(profile.connected),
    lastConnectedAt: profile.last_connected_at ?? null,
  };
}

export function summarizeSyncableHostProfile(
  profile: SyncableHostProfile
): AccountSavedRemoteHostSummary {
  const isSsh = savedHostSource(profile.provisionKind) === 'ssh';
  const hasCredential = Boolean(profile.credential?.accessToken?.trim());
  return {
    id: profile.syncKey || profile.profileId,
    name:
      profile.name ||
      savedHostAddress({
        origin: profile.origin,
        provision: profile.provision ?? null,
      }),
    kind: isSsh ? 'ssh' : 'http',
    targetLabel: isSsh
      ? formatSshTargetLabel(profile.provision ?? null, profile.origin)
      : savedHostAddress({
          origin: profile.origin,
          provision: profile.provision ?? null,
        }),
    hasCredential,
    needsToken: !hasCredential && !isSsh,
    connected: false,
    lastConnectedAt: profile.lastConnectedAt ?? null,
  };
}

function prepareProfilesForCloudUpload(
  profiles: SyncableHostProfile[]
): SyncableHostProfile[] {
  return profiles.map((item) => {
    const boundAccount =
      resolveProfileBoundAccount(item) ?? item.boundAccount ?? null;
    return {
      ...item,
      credential: null,
      boundAccount,
    };
  });
}

function stableProfileSignature(profiles: SyncableHostProfile[]): string {
  const normalized = prepareProfilesForCloudUpload(profiles)
    .map((item) => ({
      hostId: item.hostId?.trim() || '',
      profileId: item.profileId.trim(),
      name: item.name.trim(),
      origin: item.origin.trim(),
      provisionKind: item.provisionKind?.trim() || '',
      provision: item.provision ?? null,
      boundAccountUsername: item.boundAccount?.username?.trim() || '',
      boundAccountDisplayName: item.boundAccount?.displayName?.trim() || '',
      boundAccountAvatarUrl: item.boundAccount?.avatarUrl?.trim() || '',
      lastConnectedAt: item.lastConnectedAt?.trim() || '',
      updatedAt: item.updatedAt?.trim() || '',
    }))
    .sort((left, right) => {
      const leftKey = left.hostId || left.origin || left.profileId;
      const rightKey = right.hostId || right.origin || right.profileId;
      return leftKey.localeCompare(rightKey);
    });
  return JSON.stringify(normalized);
}

function matchesCloudProfile(
  local: SyncableHostProfile,
  remote: SyncableHostProfile
): boolean {
  if (local.hostId && remote.hostId && local.hostId === remote.hostId) {
    return true;
  }
  const localSshHost =
    typeof local.provision?.host === 'string' ? local.provision.host.trim() : '';
  const remoteSshHost =
    typeof remote.provision?.host === 'string'
      ? remote.provision.host.trim()
      : '';
  if (localSshHost && remoteSshHost) {
    const localUser =
      typeof local.provision?.user === 'string'
        ? local.provision.user.trim()
        : '';
    const remoteUser =
      typeof remote.provision?.user === 'string'
        ? remote.provision.user.trim()
        : '';
    const localPort = Number(local.provision?.port ?? 22) || 22;
    const remotePort = Number(remote.provision?.port ?? 22) || 22;
    if (
      localSshHost.toLowerCase() === remoteSshHost.toLowerCase() &&
      localUser === remoteUser &&
      localPort === remotePort
    ) {
      return true;
    }
  }
  if (local.profileId && local.profileId === remote.profileId) {
    return true;
  }
  return (
    Boolean(local.origin) &&
    local.origin.replace(/\/+$/, '').toLowerCase() ===
      remote.origin.replace(/\/+$/, '').toLowerCase()
  );
}

function needsCloudPush(
  localProfiles: SyncableHostProfile[],
  remoteProfiles: SyncableHostProfile[],
  accountKey: string,
  forcePush: boolean
): boolean {
  const preparedLocals = prepareProfilesForCloudUpload(localProfiles);
  if (preparedLocals.length === 0) return false;
  if (forcePush) return true;
  const localSignature = stableProfileSignature(preparedLocals);
  if (
    remoteProfiles.length === preparedLocals.length &&
    lastPushedSignatureByAccount.get(accountKey) === localSignature
  ) {
    return false;
  }
  for (const local of preparedLocals) {
    const match = remoteProfiles.find((remote) =>
      matchesCloudProfile(local, remote)
    );
    if (!match) return true;
    if (
      local.name.trim() !== match.name.trim() ||
      local.origin.replace(/\/+$/, '') !== match.origin.replace(/\/+$/, '') ||
      (local.hostId ?? null) !== (match.hostId ?? null) ||
      (local.provisionKind ?? null) !== (match.provisionKind ?? null) ||
      JSON.stringify(local.provision ?? null) !==
        JSON.stringify(match.provision ?? null) ||
      (local.boundAccount?.username ?? null) !==
        (match.boundAccount?.username ?? null) ||
      (local.boundAccount?.displayName ?? null) !==
        (match.boundAccount?.displayName ?? null) ||
      (local.boundAccount?.avatarUrl ?? null) !==
        (match.boundAccount?.avatarUrl ?? null)
    ) {
      return true;
    }
  }
  return false;
}

async function flushPendingCloudDeletes(
  pendingDeletes: PendingCloudDelete[]
): Promise<void> {
  if (pendingDeletes.length === 0) return;
  const ackedIds: string[] = [];
  for (const entry of pendingDeletes) {
    try {
      await accountApi.deleteSavedHost({
        profileId: entry.profileId || undefined,
        hostId: entry.hostId ?? undefined,
        origin: entry.origin ?? undefined,
        sshTarget: entry.sshTarget ?? undefined,
      });
      ackedIds.push(entry.id);
    } catch (error) {
      if (error instanceof AccountError && error.code === 'unsupported') {
        return;
      }
      throw error;
    }
  }
  if (ackedIds.length > 0) {
    await hostClientApi.ackSyncDeletes(ackedIds);
  }
}

async function refreshStoreFromLocalStatus(accountKey: string): Promise<void> {
  const status = await hostClientApi.status().catch(() => null);
  if (!status) return;
  emitStore({
    accountKey,
    savedHosts: (status.profiles ?? []).map(summarizeHostClientProfile),
  });
}

export async function syncAccountSavedHosts(
  user: RouterOverview['user'] | null | undefined,
  options?: { forcePush?: boolean }
): Promise<AccountSavedRemoteHostSummary[]> {
  const accountKey = resolveAccountStorageKey(user);
  if (!accountKey) return [];

  if (!isTauriClient()) {
    try {
      emitStore({ accountKey, isSyncing: true, error: null });
      const remote = await accountApi.listSavedHosts();
      const summaries = (remote.savedHosts ?? []).map(
        summarizeSyncableHostProfile
      );
      emitStore({
        accountKey,
        savedHosts: summaries,
        isSyncing: false,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });
      return summaries;
    } catch (error) {
      if (error instanceof AccountError && error.code === 'unsupported') {
        emitStore({ accountKey, isSyncing: false, error: null });
        return storeState.savedHosts;
      }
      emitStore({
        accountKey,
        isSyncing: false,
        error: error instanceof Error ? error.message : 'sync_failed',
      });
      return storeState.savedHosts;
    }
  }

  return enqueueSyncTask(async () => {
    emitStore({ accountKey, isSyncing: true, error: null });
    try {
      const legacyKeys = resolveLegacyAccountStorageKeys(user);
      await runWithEchoSuppressed(() =>
        legacyKeys.length > 0
          ? hostClientApi.setSyncAccount(accountKey, legacyKeys)
          : hostClientApi.setSyncAccount(accountKey)
      );

      const initialBundle = await hostClientApi.exportSyncProfiles(accountKey);
      await flushPendingCloudDeletes(initialBundle.pendingDeletes);

      const remoteResponse = await accountApi.listSavedHosts();
      const remoteProfiles = Array.isArray(remoteResponse.savedHosts)
        ? remoteResponse.savedHosts
        : [];
      for (const remote of remoteProfiles) {
        if (remote.boundAccount?.username) {
          writeHostBoundAccount(
            [remote.profileId, remote.hostId, remote.origin],
            remote.boundAccount
          );
        }
      }

      await runWithEchoSuppressed(() =>
        hostClientApi.mergeSyncProfiles({
          accountUserId: accountKey,
          profiles: remoteProfiles,
          authoritative: true,
        })
      );

      const postMergeBundle =
        await hostClientApi.exportSyncProfiles(accountKey);
      const preparedProfiles = prepareProfilesForCloudUpload(
        postMergeBundle.profiles
      );
      if (
        needsCloudPush(
          preparedProfiles,
          remoteProfiles,
          accountKey,
          Boolean(options?.forcePush)
        )
      ) {
        await accountApi.putSavedHosts(preparedProfiles);
        await hostClientApi.markSyncPushed(
          accountKey,
          postMergeBundle.profiles.map((item) => item.profileId)
        );
      }
      lastPushedSignatureByAccount.set(
        accountKey,
        stableProfileSignature(preparedProfiles)
      );

      await refreshStoreFromLocalStatus(accountKey);
      emitStore({
        accountKey,
        isSyncing: false,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });
      return storeState.savedHosts;
    } catch (error) {
      await refreshStoreFromLocalStatus(accountKey).catch(() => undefined);
      if (error instanceof AccountError && error.code === 'unsupported') {
        emitStore({ accountKey, isSyncing: false, error: null });
        return storeState.savedHosts;
      }
      emitStore({
        accountKey,
        isSyncing: false,
        error: error instanceof Error ? error.message : 'sync_failed',
      });
      return storeState.savedHosts;
    }
  });
}

export async function pushLocalSavedHostChanges(
  user: RouterOverview['user'] | null | undefined
): Promise<void> {
  const accountKey = resolveAccountStorageKey(user);
  if (!accountKey || !isTauriClient()) return;

  await enqueueSyncTask(async () => {
    try {
      const bundle = await hostClientApi.exportSyncProfiles(accountKey);
      await flushPendingCloudDeletes(bundle.pendingDeletes);

      const preparedProfiles = prepareProfilesForCloudUpload(bundle.profiles);
      const signature = stableProfileSignature(preparedProfiles);
      if (
        preparedProfiles.length > 0 &&
        lastPushedSignatureByAccount.get(accountKey) !== signature
      ) {
        await accountApi.putSavedHosts(preparedProfiles);
        await hostClientApi.markSyncPushed(
          accountKey,
          bundle.profiles.map((item) => item.profileId)
        );
      }
      lastPushedSignatureByAccount.set(accountKey, signature);
      await refreshStoreFromLocalStatus(accountKey);
      emitStore({
        accountKey,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      await refreshStoreFromLocalStatus(accountKey).catch(() => undefined);
      if (error instanceof AccountError && error.code === 'unsupported') {
        return;
      }
      emitStore({
        accountKey,
        error: error instanceof Error ? error.message : 'sync_failed',
      });
    }
  });
}

export async function isolateSavedHostsOnSignOut(): Promise<void> {
  lastPushedSignatureByAccount.clear();
  emitStore({
    accountKey: null,
    savedHosts: [],
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  });
  if (!isTauriClient()) return;
  await enqueueSyncTask(async () => {
    await runWithEchoSuppressed(() =>
      hostClientApi.setSyncAccount(null)
    ).catch(() => undefined);
  });
}

export function resetAccountSavedHostsForTests(): void {
  lastPushedSignatureByAccount.clear();
  suppressEchoDepth = 0;
  suppressEchoUntil = 0;
  syncQueue = Promise.resolve();
  storeState = {
    accountKey: null,
    savedHosts: [],
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  };
}

export function useAccountSavedHosts() {
  const { isSignedIn, user } = useVibeXAccount();
  const state = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot
  );
  const accountKey = isSignedIn ? resolveAccountStorageKey(user) : null;

  useEffect(() => {
    if (!accountKey || !user) return;
    if (isTauriClient()) {
      void refreshStoreFromLocalStatus(accountKey);
      let cancelled = false;
      let stop: (() => void) | undefined;
      void backendListen<void>('host-client-changed', () => {
        if (!cancelled) {
          void refreshStoreFromLocalStatus(accountKey);
        }
      })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else stop = unlisten;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        stop?.();
      };
    }
    if (state.accountKey !== accountKey) {
      void syncAccountSavedHosts(user);
    }
    return undefined;
  }, [accountKey, state.accountKey, user]);

  const syncNow = useCallback(async () => {
    if (!user) return [];
    return syncAccountSavedHosts(user, { forcePush: true });
  }, [user]);

  const savedHosts =
    accountKey && state.accountKey === accountKey ? state.savedHosts : [];

  return {
    accountKey,
    savedHosts,
    isSyncing: Boolean(accountKey) && state.isSyncing,
    lastSyncedAt:
      accountKey && state.accountKey === accountKey ? state.lastSyncedAt : null,
    error: accountKey && state.accountKey === accountKey ? state.error : null,
    syncNow,
  };
}

export function AccountSavedHostsSyncBridge(): null {
  const { isSignedIn, user } = useVibeXAccount();
  const accountKey = isSignedIn ? resolveAccountStorageKey(user) : null;
  const userRef = useRef(user);
  userRef.current = user;
  const syncedAccountRef = useRef<string | null>(null);
  const bootReconciledSignedOutRef = useRef<boolean>(false);
  const pushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauriClient() || !isPrimarySyncCoordinatorWindow()) return;

    if (!isSignedIn) {
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
      if (
        !bootReconciledSignedOutRef.current ||
        syncedAccountRef.current !== null
      ) {
        bootReconciledSignedOutRef.current = true;
        syncedAccountRef.current = null;
        void isolateSavedHostsOnSignOut();
      }
      return;
    }

    bootReconciledSignedOutRef.current = false;
    if (!accountKey || !user) {
      return;
    }

    if (syncedAccountRef.current !== accountKey) {
      syncedAccountRef.current = accountKey;
      void syncAccountSavedHosts(user);
    }
  }, [accountKey, isSignedIn, user]);

  useEffect(() => {
    if (
      !isTauriClient() ||
      !isPrimarySyncCoordinatorWindow() ||
      !isSignedIn ||
      !accountKey ||
      !user
    ) {
      return;
    }

    let disposed = false;
    let stopListener: (() => void) | undefined;
    let lastFocusSyncAt = Date.now();

    const schedulePush = () => {
      if (disposed || isEchoSuppressed() || !userRef.current) return;
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
      }
      pushTimerRef.current = window.setTimeout(() => {
        pushTimerRef.current = null;
        if (!disposed && userRef.current) {
          void pushLocalSavedHostChanges(userRef.current);
        }
      }, PUSH_DEBOUNCE_MS);
    };

    const handleWindowFocus = () => {
      if (disposed || isEchoSuppressed() || !userRef.current) return;
      const now = Date.now();
      if (now - lastFocusSyncAt < 15_000) return;
      lastFocusSyncAt = now;
      void syncAccountSavedHosts(userRef.current);
    };

    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener(HOST_BOUND_ACCOUNTS_EVENT, schedulePush);

    void backendListen<void>('host-client-changed', schedulePush)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopListener = unlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      stopListener?.();
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener(HOST_BOUND_ACCOUNTS_EVENT, schedulePush);
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, [accountKey, isSignedIn, user]);

  return null;
}
