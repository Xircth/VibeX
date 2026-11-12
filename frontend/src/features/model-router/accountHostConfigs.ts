import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import type { Config, Environment, JsonValue } from 'shared/types';

import { useUserSystem } from '@/components/ConfigProvider';
import { agentManagementApi } from '@/features/agent-management';
import i18n from '@/i18n';
import { useKeyBindingOverridesStore } from '@/keyboard/useKeyBindingOverrides';
import {
  configApi,
  frontendPreferencesApi,
  hostClientApi,
  hostTunnelApi,
  webServiceApi,
} from '@/lib/api';
import { backendListen } from '@/lib/backendTransport';
import {
  SETTINGS_CHANGED_EVENT,
  applyImportedFrontendPreferences,
  collectPortableFrontendPreferences,
  isPortablePreferenceKey,
  readDesktopSharedPreferenceSection,
  writeDesktopSharedPreferenceSection,
} from '@/lib/frontendPreferences';
import { initColorThemes } from '@/lib/theme/colorThemeStore';
import { getBackendTransport } from '@/lib/transport';
import { initAccentColor } from '@/lib/uiAccent';
import { initMonoFont } from '@/lib/uiFont';
import { getUiLanguage } from '@/lib/uiLanguage';
import { initUiZoom } from '@/lib/uiZoom';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';

import {
  AccountError,
  DESKTOP_SHARED_ACCOUNT_OWNER_KEY,
  DESKTOP_SHARED_ACCOUNT_TOKEN_KEY,
  accountApi,
  accountToken,
  writeHostBoundAccount,
  type AccountOwnerSummary,
  type RouterOverview,
} from './account';
import { resolveAccountDisplayName, useVibeXAccount } from './useVibeXAccount';

export const ACCOUNT_HOST_CONFIGS_STORAGE_KEY = 'vibex.account.hostConfigs.v1';
export const DESKTOP_SHARED_HOST_CONFIGS_KEY = '__account_host_configs_v1';
const ACCOUNT_HOST_CONFIGS_EVENT = 'vibex:account-host-configs-changed';
const AUTO_SYNC_DEBOUNCE_MS = 800;

export type AccountHostKind = 'local' | 'ssh' | 'remote' | 'web';

type NonPortableUserConfigKey =
  | 'config_version'
  | 'disclaimer_acknowledged'
  | 'onboarding_acknowledged'
  | 'workspace_dir'
  | 'last_app_version'
  | 'github';

export type PortableUserConfig = Omit<Config, NonPortableUserConfigKey>;

export type HostAgentEnablementItem = {
  agentId: string;
  displayName: string;
  enabled: boolean;
  position: number;
  builtIn: boolean;
};

export type AccountHostConfigSnapshot = {
  schemaVersion: 1;
  accountKey: string;
  hostId: string;
  hostName: string;
  kind: AccountHostKind;
  osType: string;
  osArch: string;
  updatedAt: string;
  fingerprint: string;
  vibeXSettings: {
    userConfig: Partial<PortableUserConfig>;
    frontendPreferences: Record<string, JsonValue>;
  };
  agents: HostAgentEnablementItem[];
};

export type ImportHostConfigOptions = {
  includeSettings: boolean;
  includeAgents: boolean;
};

export type ImportHostConfigResult = {
  appliedSettings: boolean;
  updatedAgentsCount: number;
  skippedMissingAgentIds: string[];
  failedAgentIds: string[];
};

export type AccountHostListEntry = {
  hostId: string;
  hostName: string;
  kind: AccountHostKind;
  osType: string;
  osArch: string;
  updatedAt: string;
  isCurrent: boolean;
  configSynced: boolean;
  snapshot: AccountHostConfigSnapshot | null;
};

type UnsyncedHostRecord = {
  hostId: string;
  hostName: string;
  kind: AccountHostKind;
  osType: string;
  osArch: string;
  updatedAt: string;
};

type AccountBucket = {
  hosts: Record<string, AccountHostConfigSnapshot>;
  deleted: Record<string, string>;
};

type StoredHostConfigsEnvelope = {
  version: 1;
  accounts: Record<string, AccountBucket>;
};

type CurrentHostIdentity = {
  hostId: string;
  hostName: string;
  kind: AccountHostKind;
};

type AccountHostConfigStoreState = {
  accountKey: string | null;
  currentHostId: string | null;
  hosts: AccountHostConfigSnapshot[];
  unsyncedHosts: UnsyncedHostRecord[];
  isSyncing: boolean;
  isImporting: boolean;
  lastSyncedAt: string | null;
  error: string | null;
};

const NON_PORTABLE_USER_CONFIG_KEYS = new Set<string>([
  'config_version',
  'disclaimer_acknowledged',
  'onboarding_acknowledged',
  'workspace_dir',
  'last_app_version',
  'github',
]);

const webHealthCache = new Map<
  string,
  { hostId: string | null; name: string | null }
>();

let storeState: AccountHostConfigStoreState = {
  accountKey: null,
  currentHostId: null,
  hosts: [],
  unsyncedHosts: [],
  isSyncing: false,
  isImporting: false,
  lastSyncedAt: null,
  error: null,
};

let importingDepth = 0;
let activeSyncPromise: Promise<AccountHostConfigSnapshot[]> | null = null;
let activeSyncAccountKey: string | null = null;
const storeListeners = new Set<() => void>();

function emitStore(next: Partial<AccountHostConfigStoreState>): void {
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

function getStoreSnapshot(): AccountHostConfigStoreState {
  return storeState;
}

export function resolveAccountStorageKey(
  user?: RouterOverview['user'] | null
): string | null {
  if (!user) return null;
  const candidate =
    user.id?.trim() || user.username?.trim() || user.email?.trim() || '';
  return candidate ? candidate.toLowerCase() : null;
}

export function resolveLegacyAccountStorageKeys(
  user?: RouterOverview['user'] | null
): string[] {
  if (!user?.id?.trim()) return [];
  const primary = resolveAccountStorageKey(user);
  if (!primary) return [];
  const candidates = [user.username?.trim(), user.email?.trim()]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return [...new Set(candidates)].filter((key) => key !== primary);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`
    )
    .join(',')}}`;
}

function hashFingerprint(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1_${(hash >>> 0).toString(16).padStart(8, '0')}_${input.length}`;
}

export function computeHostConfigFingerprint(payload: {
  hostName: string;
  kind: AccountHostKind;
  osType: string;
  osArch: string;
  vibeXSettings: AccountHostConfigSnapshot['vibeXSettings'];
  agents: HostAgentEnablementItem[];
}): string {
  return hashFingerprint(stableStringify(payload));
}

export function extractPortableUserConfig(
  config: Config
): Partial<PortableUserConfig> {
  const portable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (NON_PORTABLE_USER_CONFIG_KEYS.has(key) || value === undefined) {
      continue;
    }
    portable[key] = value;
  }
  return portable as Partial<PortableUserConfig>;
}

export function mergePortableUserConfigOntoTarget(params: {
  targetConfig: Config;
  targetEnvironment: Environment | null;
  sourceUserConfig: Partial<PortableUserConfig>;
  sourceOsType: string;
}): Config {
  const { targetConfig, targetEnvironment, sourceUserConfig, sourceOsType } =
    params;
  const sameOs =
    Boolean(sourceOsType) &&
    Boolean(targetEnvironment?.os_type) &&
    sourceOsType.trim().toLowerCase() ===
      targetEnvironment!.os_type.trim().toLowerCase();

  const sanitizedUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sourceUserConfig)) {
    if (NON_PORTABLE_USER_CONFIG_KEYS.has(key) || value === undefined) {
      continue;
    }
    if (key === 'default_terminal_shell' && !sameOs) {
      continue;
    }
    if (
      key === 'editor' &&
      !sameOs &&
      value &&
      typeof value === 'object' &&
      'custom_command' in (value as Record<string, unknown>)
    ) {
      sanitizedUpdates[key] = {
        ...(value as Record<string, unknown>),
        custom_command: targetConfig.editor.custom_command,
      };
      continue;
    }
    sanitizedUpdates[key] = value;
  }

  return {
    ...targetConfig,
    ...(sanitizedUpdates as Partial<Config>),
    config_version: targetConfig.config_version,
    disclaimer_acknowledged: targetConfig.disclaimer_acknowledged,
    onboarding_acknowledged: targetConfig.onboarding_acknowledged,
    workspace_dir: targetConfig.workspace_dir,
    last_app_version: targetConfig.last_app_version,
    github: targetConfig.github,
  };
}

function coerceSnapshot(
  raw: unknown,
  expectedAccountKey?: string
): AccountHostConfigSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AccountHostConfigSnapshot>;
  if (
    typeof candidate.hostId !== 'string' ||
    !candidate.hostId.trim() ||
    typeof candidate.hostName !== 'string' ||
    !candidate.hostName.trim()
  ) {
    return null;
  }
  const accountKey =
    typeof candidate.accountKey === 'string' && candidate.accountKey.trim()
      ? candidate.accountKey.trim().toLowerCase()
      : (expectedAccountKey ?? '');
  if (!accountKey) return null;
  if (expectedAccountKey && accountKey !== expectedAccountKey) {
    return null;
  }
  const kind: AccountHostKind =
    candidate.kind === 'local' ||
    candidate.kind === 'ssh' ||
    candidate.kind === 'remote' ||
    candidate.kind === 'web'
      ? candidate.kind
      : 'remote';
  const userConfig =
    candidate.vibeXSettings?.userConfig &&
    typeof candidate.vibeXSettings.userConfig === 'object'
      ? candidate.vibeXSettings.userConfig
      : {};
  const rawPrefs =
    candidate.vibeXSettings?.frontendPreferences &&
    typeof candidate.vibeXSettings.frontendPreferences === 'object'
      ? candidate.vibeXSettings.frontendPreferences
      : {};
  const frontendPreferences = Object.fromEntries(
    Object.entries(rawPrefs).filter(
      ([key, value]) => value !== undefined && isPortablePreferenceKey(key)
    )
  );
  const agents: HostAgentEnablementItem[] = Array.isArray(candidate.agents)
    ? candidate.agents
        .filter(
          (item): item is HostAgentEnablementItem =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof item.agentId === 'string' &&
            Boolean(item.agentId.trim())
        )
        .map((item, idx) => ({
          agentId: item.agentId,
          displayName:
            typeof item.displayName === 'string' && item.displayName.trim()
              ? item.displayName
              : item.agentId,
          enabled: Boolean(item.enabled),
          position: typeof item.position === 'number' ? item.position : idx,
          builtIn: Boolean(item.builtIn),
        }))
    : [];

  const osType = typeof candidate.osType === 'string' ? candidate.osType : '';
  const osArch = typeof candidate.osArch === 'string' ? candidate.osArch : '';
  const updatedAt =
    typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
      ? candidate.updatedAt
      : new Date(0).toISOString();
  const vibeXSettings = {
    userConfig,
    frontendPreferences,
  };
  const fingerprint =
    typeof candidate.fingerprint === 'string' && candidate.fingerprint
      ? candidate.fingerprint
      : computeHostConfigFingerprint({
          hostName: candidate.hostName.trim(),
          kind,
          osType,
          osArch,
          vibeXSettings,
          agents,
        });

  return {
    schemaVersion: 1,
    accountKey,
    hostId: candidate.hostId.trim(),
    hostName: candidate.hostName.trim(),
    kind,
    osType,
    osArch,
    updatedAt,
    fingerprint,
    vibeXSettings,
    agents,
  };
}

function emptyEnvelope(): StoredHostConfigsEnvelope {
  return { version: 1, accounts: {} };
}

function parseEnvelope(raw: unknown): StoredHostConfigsEnvelope {
  if (!raw || typeof raw !== 'object') return emptyEnvelope();
  const obj = raw as Partial<StoredHostConfigsEnvelope>;
  if (!obj.accounts || typeof obj.accounts !== 'object') {
    return emptyEnvelope();
  }
  const accounts: Record<string, AccountBucket> = {};
  for (const [rawKey, rawBucket] of Object.entries(obj.accounts)) {
    const accountKey = rawKey.trim().toLowerCase();
    if (!accountKey || !rawBucket || typeof rawBucket !== 'object') continue;
    const bucketObj = rawBucket as Partial<AccountBucket>;
    const hosts: Record<string, AccountHostConfigSnapshot> = {};
    if (bucketObj.hosts && typeof bucketObj.hosts === 'object') {
      for (const value of Object.values(bucketObj.hosts)) {
        const parsed = coerceSnapshot(value, accountKey);
        if (parsed) {
          hosts[parsed.hostId] = parsed;
        }
      }
    }
    const deleted: Record<string, string> = {};
    if (bucketObj.deleted && typeof bucketObj.deleted === 'object') {
      for (const [hostId, deletedAt] of Object.entries(bucketObj.deleted)) {
        if (
          hostId.trim() &&
          typeof deletedAt === 'string' &&
          deletedAt.trim()
        ) {
          deleted[hostId.trim()] = deletedAt;
        }
      }
    }
    accounts[accountKey] = { hosts, deleted };
  }
  return { version: 1, accounts };
}

function readLocalStorageEnvelope(): StoredHostConfigsEnvelope {
  if (typeof window === 'undefined') return emptyEnvelope();
  try {
    const raw = window.localStorage.getItem(ACCOUNT_HOST_CONFIGS_STORAGE_KEY);
    if (!raw) return emptyEnvelope();
    return parseEnvelope(JSON.parse(raw));
  } catch {
    return emptyEnvelope();
  }
}

function writeLocalStorageEnvelope(envelope: StoredHostConfigsEnvelope): void {
  if (typeof window === 'undefined') return;
  const encoded = JSON.stringify(envelope);
  if (
    window.localStorage.getItem(ACCOUNT_HOST_CONFIGS_STORAGE_KEY) === encoded
  ) {
    return;
  }
  window.localStorage.setItem(ACCOUNT_HOST_CONFIGS_STORAGE_KEY, encoded);
  window.dispatchEvent(new Event(ACCOUNT_HOST_CONFIGS_EVENT));
}

function compareIsoTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }
  return left.localeCompare(right);
}

function mergeAccountBuckets(
  left: AccountBucket | undefined,
  right: AccountBucket | undefined
): AccountBucket {
  const deleted: Record<string, string> = { ...(left?.deleted ?? {}) };
  for (const [hostId, deletedAt] of Object.entries(right?.deleted ?? {})) {
    const prev = deleted[hostId];
    if (!prev || compareIsoTimestamps(deletedAt, prev) > 0) {
      deleted[hostId] = deletedAt;
    }
  }

  const hosts: Record<string, AccountHostConfigSnapshot> = {};
  for (const source of [left?.hosts ?? {}, right?.hosts ?? {}]) {
    for (const [hostId, snapshot] of Object.entries(source)) {
      const deletedAt = deleted[hostId];
      if (
        deletedAt &&
        compareIsoTimestamps(deletedAt, snapshot.updatedAt) >= 0
      ) {
        continue;
      }
      const existing = hosts[hostId];
      if (
        !existing ||
        compareIsoTimestamps(snapshot.updatedAt, existing.updatedAt) > 0
      ) {
        hosts[hostId] = snapshot;
      }
    }
  }

  return { hosts, deleted };
}

function mergeEnvelopes(
  left: StoredHostConfigsEnvelope,
  right: StoredHostConfigsEnvelope
): StoredHostConfigsEnvelope {
  const keys = new Set<string>([
    ...Object.keys(left.accounts),
    ...Object.keys(right.accounts),
  ]);
  const accounts: Record<string, AccountBucket> = {};
  for (const key of keys) {
    accounts[key] = mergeAccountBuckets(
      left.accounts[key],
      right.accounts[key]
    );
  }
  return { version: 1, accounts };
}

async function readCombinedEnvelope(): Promise<StoredHostConfigsEnvelope> {
  const local = readLocalStorageEnvelope();
  const desktopSharedRaw = await readDesktopSharedPreferenceSection<unknown>(
    DESKTOP_SHARED_HOST_CONFIGS_KEY
  );
  if (!desktopSharedRaw) {
    return local;
  }
  return mergeEnvelopes(local, parseEnvelope(desktopSharedRaw));
}

async function persistCombinedEnvelope(
  envelope: StoredHostConfigsEnvelope
): Promise<void> {
  writeLocalStorageEnvelope(envelope);
  await writeDesktopSharedPreferenceSection(
    DESKTOP_SHARED_HOST_CONFIGS_KEY,
    envelope as unknown as JsonValue
  );
}

function formatOriginLabel(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.host || origin;
  } catch {
    return origin;
  }
}

async function probeWebHostHealth(
  origin: string
): Promise<{ hostId: string | null; name: string | null }> {
  const cached = webHealthCache.get(origin);
  if (cached) return cached;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      const fallback = { hostId: null, name: null };
      webHealthCache.set(origin, fallback);
      return fallback;
    }
    const payload = (await response.json().catch(() => null)) as {
      host_id?: unknown;
      name?: unknown;
    } | null;
    const resolved = {
      hostId:
        typeof payload?.host_id === 'string' && payload.host_id.trim()
          ? payload.host_id.trim()
          : null,
      name:
        typeof payload?.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : null,
    };
    webHealthCache.set(origin, resolved);
    return resolved;
  } catch {
    return { hostId: null, name: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveCurrentHostIdentity(): Promise<CurrentHostIdentity> {
  const transport = getBackendTransport();
  if (transport.environment === 'desktop') {
    const status = await webServiceApi.getStatus().catch(() => null);
    const hostId = status?.host_id?.trim()
      ? `host:${status.host_id.trim()}`
      : 'host:local-desktop';
    return {
      hostId,
      hostName: 'Local Host',
      kind: 'local',
    };
  }

  if (transport.environment === 'remote-desktop') {
    const status = await hostClientApi.status().catch(() => null);
    const profile = status?.profile;
    const hostId = profile?.host_id?.trim()
      ? `host:${profile.host_id.trim()}`
      : profile?.id?.trim()
        ? `profile:${profile.id.trim()}`
        : profile?.origin?.trim()
          ? `origin:${profile.origin.trim()}`
          : 'host:remote-desktop';
    const hostName =
      profile?.name?.trim() ||
      (profile?.origin ? formatOriginLabel(profile.origin) : 'Remote Host');
    const kind: AccountHostKind =
      profile?.provision_kind === 'ssh' ? 'ssh' : 'remote';
    return { hostId, hostName, kind };
  }

  const origin =
    (transport as { origin?: string }).origin?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  const health = origin
    ? await probeWebHostHealth(origin)
    : { hostId: null, name: null };
  const hostId = health.hostId
    ? `host:${health.hostId}`
    : `web:${origin || 'default'}`;
  const isLoopback =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
  const hostName =
    health.name ||
    (isLoopback ? 'Local Host' : formatOriginLabel(origin || 'Web Host'));
  return {
    hostId,
    hostName,
    kind: isLoopback ? 'local' : 'web',
  };
}

export async function captureCurrentHostSnapshot(
  accountKey: string
): Promise<AccountHostConfigSnapshot> {
  const [identity, systemInfo, frontendPreferences, agentRows] =
    await Promise.all([
      resolveCurrentHostIdentity(),
      configApi.getConfig(),
      collectPortableFrontendPreferences(),
      agentManagementApi.bar().catch(() => []),
    ]);

  const userConfig = extractPortableUserConfig(systemInfo.config);
  const agents: HostAgentEnablementItem[] = [...agentRows]
    .sort((left, right) => left.position - right.position)
    .map((agent, index) => ({
      agentId: agent.agent_id,
      displayName: agent.display_name || agent.agent_id,
      enabled: Boolean(agent.enabled),
      position: typeof agent.position === 'number' ? agent.position : index,
      builtIn: Boolean(agent.built_in),
    }));

  const osType = systemInfo.environment?.os_type ?? '';
  const osArch = systemInfo.environment?.os_architecture ?? '';
  const vibeXSettings = {
    userConfig,
    frontendPreferences,
  };
  const fingerprint = computeHostConfigFingerprint({
    hostName: identity.hostName,
    kind: identity.kind,
    osType,
    osArch,
    vibeXSettings,
    agents,
  });

  return {
    schemaVersion: 1,
    accountKey,
    hostId: identity.hostId,
    hostName: identity.hostName,
    kind: identity.kind,
    osType,
    osArch,
    updatedAt: new Date().toISOString(),
    fingerprint,
    vibeXSettings,
    agents,
  };
}

function sortHostSnapshots(
  hosts: Iterable<AccountHostConfigSnapshot>,
  currentHostId: string | null
): AccountHostConfigSnapshot[] {
  return [...hosts].sort((left, right) => {
    const leftCurrent = left.hostId === currentHostId;
    const rightCurrent = right.hostId === currentHostId;
    if (leftCurrent !== rightCurrent) {
      return leftCurrent ? -1 : 1;
    }
    return compareIsoTimestamps(right.updatedAt, left.updatedAt);
  });
}

function isIgnorableCloudSyncError(cause: unknown): boolean {
  return (
    cause instanceof AccountError &&
    (cause.code === 'unsupported' || cause.code === 'network')
  );
}

function parseAccountOwnerSummary(raw: unknown): AccountOwnerSummary | null {
  let candidate = raw;
  if (typeof candidate === 'string' && candidate.trim().startsWith('{')) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  const username = typeof obj.username === 'string' ? obj.username.trim() : '';
  if (!username) return null;
  const displayName =
    typeof obj.displayName === 'string' && obj.displayName.trim()
      ? obj.displayName.trim()
      : username;
  const avatarUrl =
    typeof obj.avatarUrl === 'string' && obj.avatarUrl.trim()
      ? obj.avatarUrl.trim()
      : null;
  return { username, displayName, avatarUrl };
}

type RemoteHostProfileSummary = {
  id?: string | null;
  host_id?: string | null;
  origin?: string | null;
};

function isRemoteHostProfileSummary(
  value: unknown
): value is RemoteHostProfileSummary {
  if (!value || typeof value !== 'object') return false;
  return 'origin' in value || 'host_id' in value;
}

export async function reconcileRemoteHostAccount(
  userOrProfile?: RouterOverview['user'] | RemoteHostProfileSummary | null,
  profileOverride?: RemoteHostProfileSummary | null
): Promise<{
  syncedToRemote: boolean;
  differentAccount: AccountOwnerSummary | null;
}> {
  const passedProfile = isRemoteHostProfileSummary(userOrProfile)
    ? userOrProfile
    : (profileOverride ?? null);
  let user = isRemoteHostProfileSummary(userOrProfile)
    ? null
    : (userOrProfile ?? null);

  if (
    !passedProfile &&
    getBackendTransport().environment !== 'remote-desktop'
  ) {
    return { syncedToRemote: true, differentAccount: null };
  }
  const [status, remotePrefs] = await Promise.all([
    passedProfile
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => hostClientApi.status())
          .catch(() => null),
    Promise.resolve()
      .then(() => frontendPreferencesApi.get())
      .catch(() => null),
  ]);
  const profile = passedProfile ?? status?.profile ?? null;
  const rawHostId = profile?.host_id?.trim().replace(/^host:/, '') || '';
  const profileKeys = [
    profile?.id,
    profile?.id ? `profile:${profile.id}` : null,
    rawHostId || null,
    rawHostId ? `host:${rawHostId}` : null,
    profile?.origin?.trim().replace(/\/+$/, '') || null,
    profile?.origin ? `origin:${profile.origin.trim().replace(/\/+$/, '')}` : null,
  ];

  const remoteTokenRaw = remotePrefs?.[DESKTOP_SHARED_ACCOUNT_TOKEN_KEY];
  const remoteToken =
    typeof remoteTokenRaw === 'string'
      ? remoteTokenRaw.trim()
      : remoteTokenRaw &&
          typeof remoteTokenRaw === 'object' &&
          typeof (remoteTokenRaw as { token?: unknown }).token === 'string'
        ? ((remoteTokenRaw as { token: string }).token || '').trim()
        : '';
  let remoteOwner = parseAccountOwnerSummary(
    remotePrefs?.[DESKTOP_SHARED_ACCOUNT_OWNER_KEY]
  );

  const localToken = accountToken()?.trim() || '';
  if (!user && localToken) {
    const localOverview = await accountApi.overview().catch(() => null);
    user = localOverview?.user ?? null;
  }
  const localUsername = user?.username?.trim() || '';

  if (!remoteOwner && remoteToken && remoteToken !== localToken) {
    const remoteOverview = await accountApi
      .overviewWithToken(remoteToken)
      .catch(() => null);
    if (remoteOverview?.user?.username) {
      remoteOwner = {
        username: remoteOverview.user.username.trim(),
        displayName: resolveAccountDisplayName(remoteOverview.user),
        avatarUrl: remoteOverview.user.avatarUrl ?? null,
      };
    }
  }

  // Case 1: Remote Host has no logged-in VibeX account -> automatically sync current account to it
  if (!remoteToken && !remoteOwner) {
    if (localToken && localUsername) {
      await Promise.resolve()
        .then(() =>
          frontendPreferencesApi.update({
            [DESKTOP_SHARED_ACCOUNT_TOKEN_KEY]: localToken,
            [DESKTOP_SHARED_ACCOUNT_OWNER_KEY]: {
              username: localUsername,
              displayName: resolveAccountDisplayName(user),
              avatarUrl: user?.avatarUrl ?? null,
            },
          })
        )
        .catch(() => undefined);
    }
    writeHostBoundAccount(profileKeys, null);
    return { syncedToRemote: true, differentAccount: null };
  }

  // Case 2: Remote Host is logged into a DIFFERENT user's VibeX account -> do NOT overwrite; record boundAccount
  if (
    remoteOwner &&
    (!localUsername ||
      remoteOwner.username.toLowerCase() !== localUsername.toLowerCase())
  ) {
    writeHostBoundAccount(profileKeys, remoteOwner);
    return { syncedToRemote: false, differentAccount: remoteOwner };
  }

  // Case 3: Remote Host is logged into the SAME user's VibeX account
  writeHostBoundAccount(profileKeys, null);
  if (localToken && localUsername && remoteToken !== localToken) {
    await Promise.resolve()
      .then(() =>
        frontendPreferencesApi.update({
          [DESKTOP_SHARED_ACCOUNT_TOKEN_KEY]: localToken,
          [DESKTOP_SHARED_ACCOUNT_OWNER_KEY]: {
            username: localUsername,
            displayName: resolveAccountDisplayName(user),
            avatarUrl: user?.avatarUrl ?? null,
          },
        })
      )
      .catch(() => undefined);
  }
  return { syncedToRemote: true, differentAccount: null };
}

async function issueAndApplyLocalRelayLease(input: {
  hostId: string;
  hostName?: string;
  osType?: string;
  osArch?: string;
}): Promise<boolean> {
  try {
    const lease = await accountApi.issueRelayLease(input);
    await hostTunnelApi
      .setAccountLease({
        lease_token: lease.leaseToken,
        expires_at: lease.expiresAt,
        relay_host: lease.relayHost,
        relay_port: lease.relayPort,
        tenant_origin: lease.tenantOrigin,
        host_id: lease.hostId,
        lease_version: lease.leaseVersion,
        server_id: lease.serverId ?? null,
        server_name: lease.serverName ?? null,
      })
      .catch(() => undefined);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('vibex:host-tunnel-updated'));
    }
    return true;
  } catch {
    await hostTunnelApi.setAccountLease(null).catch(() => undefined);
    return false;
  }
}

export async function syncCurrentHostRelayLease(): Promise<boolean> {
  if (!accountToken()) return false;
  const identity = await resolveCurrentHostIdentity().catch(() => null);
  if (!identity || identity.kind !== 'local' || !identity.hostId) {
    return false;
  }
  return issueAndApplyLocalRelayLease({
    hostId: identity.hostId,
    hostName: identity.hostName,
  });
}

export async function syncAccountHostConfigs(
  user: RouterOverview['user'] | null | undefined,
  options?: { forceSaveCurrent?: boolean }
): Promise<AccountHostConfigSnapshot[]> {
  const accountKey = resolveAccountStorageKey(user);
  if (!accountKey) {
    emitStore({
      accountKey: null,
      currentHostId: null,
      hosts: [],
      unsyncedHosts: [],
      isSyncing: false,
      error: null,
    });
    return [];
  }

  if (importingDepth > 0 && !options?.forceSaveCurrent) {
    return storeState.hosts;
  }

  if (
    activeSyncPromise &&
    activeSyncAccountKey === accountKey &&
    !options?.forceSaveCurrent
  ) {
    return activeSyncPromise;
  }

  emitStore({ accountKey, isSyncing: true, error: null });

  let run: Promise<AccountHostConfigSnapshot[]> | null = null;
  run = (async () => {
    try {
      const envelope = await readCombinedEnvelope();
      const legacyKeys = resolveLegacyAccountStorageKeys(user);
      let bucket: AccountBucket = envelope.accounts[accountKey] ?? {
        hosts: {},
        deleted: {},
      };
      for (const legacyKey of legacyKeys) {
        if (envelope.accounts[legacyKey]) {
          bucket = mergeAccountBuckets(bucket, envelope.accounts[legacyKey]);
        }
      }
      const remoteUnsynced: UnsyncedHostRecord[] = [];
      const cloudHosts: Record<string, AccountHostConfigSnapshot> = {};
      let cloudListLoaded = false;

      // Merge cloud-stored snapshots & historical Host records when available.
      try {
        const remote = await accountApi.listHostConfigs();
        cloudListLoaded = true;
        if (Array.isArray(remote.hosts)) {
          for (const rawHost of remote.hosts) {
            const parsed = coerceSnapshot(rawHost, accountKey);
            if (parsed) {
              cloudHosts[parsed.hostId] = parsed;
            }
          }
          bucket = mergeAccountBuckets(bucket, {
            hosts: cloudHosts,
            deleted: {},
          });
        }
        if (Array.isArray(remote.records)) {
          for (const rawRecord of remote.records) {
            if (!rawRecord || typeof rawRecord !== 'object') continue;
            const rec = rawRecord as Record<string, unknown>;
            if (rec.configSynced === true) continue;
            const hostId =
              typeof rec.hostId === 'string' ? rec.hostId.trim() : '';
            const hostName =
              typeof rec.hostName === 'string' ? rec.hostName.trim() : '';
            if (!hostId || !hostName) continue;
            const kind: AccountHostKind =
              rec.kind === 'local' ||
              rec.kind === 'ssh' ||
              rec.kind === 'remote' ||
              rec.kind === 'web'
                ? rec.kind
                : 'local';
            remoteUnsynced.push({
              hostId,
              hostName,
              kind,
              osType: typeof rec.osType === 'string' ? rec.osType : '',
              osArch: typeof rec.osArch === 'string' ? rec.osArch : '',
              updatedAt:
                typeof rec.lastSeenAt === 'string' && rec.lastSeenAt.trim()
                  ? rec.lastSeenAt
                  : new Date(0).toISOString(),
            });
          }
        }
      } catch (cloudError) {
        if (!isIgnorableCloudSyncError(cloudError)) {
          // Non-fatal: continue with client-persisted snapshots.
        }
      }

      const reconciledRemote =
        getBackendTransport().environment === 'remote-desktop'
          ? await reconcileRemoteHostAccount(user)
          : { syncedToRemote: true, differentAccount: null };

      const captured = await captureCurrentHostSnapshot(accountKey);
      const isDifferentRemoteAccount = Boolean(
        reconciledRemote.differentAccount
      );
      const existingCurrent = bucket.hosts[captured.hostId];
      const shouldUpdateLocalCurrent =
        !isDifferentRemoteAccount &&
        (Boolean(options?.forceSaveCurrent) ||
          !existingCurrent ||
          existingCurrent.fingerprint !== captured.fingerprint ||
          (existingCurrent.agents.length === 0 && captured.agents.length > 0));

      const effectiveCurrent = shouldUpdateLocalCurrent
        ? captured
        : (existingCurrent ?? captured);
      const nextDeleted = { ...bucket.deleted };
      delete nextDeleted[captured.hostId];
      const nextHosts = { ...bucket.hosts };
      if (!isDifferentRemoteAccount) {
        nextHosts[captured.hostId] = effectiveCurrent;
      }
      const nextBucket: AccountBucket = {
        hosts: nextHosts,
        deleted: nextDeleted,
      };

      const nextAccounts: Record<string, AccountBucket> = {
        ...envelope.accounts,
        [accountKey]: nextBucket,
      };
      for (const legacyKey of legacyKeys) {
        delete nextAccounts[legacyKey];
      }
      const nextEnvelope: StoredHostConfigsEnvelope = {
        version: 1,
        accounts: nextAccounts,
      };
      await persistCombinedEnvelope(nextEnvelope);

      const snapshotsToPush: AccountHostConfigSnapshot[] = [];
      for (const snapshot of Object.values(nextBucket.hosts)) {
        const isCurrent = snapshot.hostId === captured.hostId;
        const cloudExisting = cloudHosts[snapshot.hostId];
        const needsCloudPush = isCurrent
          ? shouldUpdateLocalCurrent ||
            (cloudListLoaded &&
              Boolean(cloudExisting) &&
              (cloudExisting.fingerprint !== snapshot.fingerprint ||
                (cloudExisting.agents.length === 0 &&
                  snapshot.agents.length > 0)))
          : cloudListLoaded &&
            (!cloudExisting ||
              cloudExisting.fingerprint !== snapshot.fingerprint ||
              (cloudExisting.agents.length === 0 &&
                snapshot.agents.length > 0));
        if (needsCloudPush) {
          snapshotsToPush.push(snapshot);
        }
      }

      for (const snapshot of snapshotsToPush) {
        await accountApi.saveHostConfig(snapshot).catch((cause) => {
          if (!isIgnorableCloudSyncError(cause)) {
            console.warn('Failed to push host config to cloud account:', cause);
          }
        });
      }

      if (captured.kind === 'local' && captured.hostId) {
        await issueAndApplyLocalRelayLease({
          hostId: captured.hostId,
          hostName: captured.hostName,
          osType: captured.osType || undefined,
          osArch: captured.osArch || undefined,
        });
      }

      const ordered = sortHostSnapshots(
        Object.values(nextBucket.hosts),
        captured.hostId
      );
      const filteredUnsynced = remoteUnsynced.filter(
        (item) =>
          item.hostId !== captured.hostId &&
          !nextBucket.hosts[item.hostId] &&
          !ordered.some(
            (synced) =>
              synced.hostName.toLowerCase() === item.hostName.toLowerCase()
          )
      );
      emitStore({
        accountKey,
        currentHostId: captured.hostId,
        hosts: ordered,
        unsyncedHosts: filteredUnsynced,
        isSyncing: false,
        lastSyncedAt: effectiveCurrent.updatedAt,
        error: null,
      });
      return ordered;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      emitStore({
        isSyncing: false,
        error: message,
      });
      return storeState.hosts;
    } finally {
      if (activeSyncPromise === run) {
        activeSyncPromise = null;
        activeSyncAccountKey = null;
      }
    }
  })();

  activeSyncPromise = run;
  activeSyncAccountKey = accountKey;
  return run;
}

export async function removeSavedAccountHostConfig(params: {
  user: RouterOverview['user'] | null | undefined;
  hostId: string;
}): Promise<void> {
  const accountKey = resolveAccountStorageKey(params.user);
  if (!accountKey) return;
  const targetHostId = params.hostId.trim();
  if (!targetHostId || targetHostId === storeState.currentHostId) return;

  const envelope = await readCombinedEnvelope();
  const existing = envelope.accounts[accountKey] ?? { hosts: {}, deleted: {} };
  const nextHosts = { ...existing.hosts };
  delete nextHosts[targetHostId];
  const nextBucket: AccountBucket = {
    hosts: nextHosts,
    deleted: {
      ...existing.deleted,
      [targetHostId]: new Date().toISOString(),
    },
  };
  await persistCombinedEnvelope({
    version: 1,
    accounts: {
      ...envelope.accounts,
      [accountKey]: nextBucket,
    },
  });

  await accountApi.deleteHostConfig(targetHostId).catch(() => undefined);

  emitStore({
    hosts: sortHostSnapshots(
      Object.values(nextBucket.hosts),
      storeState.currentHostId
    ),
  });
}

async function refreshLiveFrontendSingletons(): Promise<void> {
  initUiZoom();
  initColorThemes();
  initAccentColor();
  initMonoFont();
  const language = getUiLanguage();
  await Promise.all([
    language === i18n.language
      ? Promise.resolve()
      : i18n.changeLanguage(language),
    useEditorSettingsStore.persist.rehydrate(),
    useKeyBindingOverridesStore.persist.rehydrate(),
  ]);
}

export async function importHostConfigToCurrentHost(params: {
  user: RouterOverview['user'] | null | undefined;
  source: AccountHostConfigSnapshot;
  options: ImportHostConfigOptions;
  queryClient?: QueryClient;
}): Promise<ImportHostConfigResult> {
  const { user, source, options, queryClient } = params;
  importingDepth += 1;
  emitStore({ isImporting: true, error: null });

  let appliedSettings = false;
  let updatedAgentsCount = 0;
  const skippedMissingAgentIds: string[] = [];
  const failedAgentIds: string[] = [];

  try {
    if (options.includeSettings) {
      const currentSystem = await configApi.getConfig();
      const mergedConfig = mergePortableUserConfigOntoTarget({
        targetConfig: currentSystem.config,
        targetEnvironment: currentSystem.environment ?? null,
        sourceUserConfig: source.vibeXSettings.userConfig,
        sourceOsType: source.osType,
      });
      const savedConfig = await configApi.saveConfig(mergedConfig);
      if (queryClient) {
        queryClient.setQueryData(['user-system'], {
          ...currentSystem,
          config: savedConfig,
        });
      }
      await applyImportedFrontendPreferences(
        source.vibeXSettings.frontendPreferences
      );
      await refreshLiveFrontendSingletons();
      appliedSettings = true;
    }

    if (options.includeAgents) {
      const targetAgents = await agentManagementApi.bar();
      const targetById = new Map(
        targetAgents.map((agent) => [agent.agent_id, agent])
      );

      for (const sourceAgent of source.agents) {
        const targetAgent = targetById.get(sourceAgent.agentId);
        if (!targetAgent) {
          skippedMissingAgentIds.push(sourceAgent.agentId);
          continue;
        }
        if (Boolean(targetAgent.enabled) === Boolean(sourceAgent.enabled)) {
          continue;
        }
        try {
          await agentManagementApi.setEnabled(
            sourceAgent.agentId,
            sourceAgent.enabled
          );
          updatedAgentsCount += 1;
        } catch {
          failedAgentIds.push(sourceAgent.agentId);
        }
      }

      const sourceOrderIds = [...source.agents]
        .sort((left, right) => left.position - right.position)
        .map((item) => item.agentId)
        .filter((agentId) => targetById.has(agentId));
      const seen = new Set(sourceOrderIds);
      const remainingTargetIds = [...targetAgents]
        .sort((left, right) => left.position - right.position)
        .map((agent) => agent.agent_id)
        .filter((agentId) => !seen.has(agentId));
      const desiredOrder = [...sourceOrderIds, ...remainingTargetIds];
      const currentOrder = [...targetAgents]
        .sort((left, right) => left.position - right.position)
        .map((agent) => agent.agent_id);
      const orderChanged =
        desiredOrder.length === currentOrder.length &&
        desiredOrder.some((id, index) => id !== currentOrder[index]);
      if (orderChanged) {
        await agentManagementApi.reorder(desiredOrder).catch(() => undefined);
      }
    }

    if (queryClient) {
      await queryClient.invalidateQueries({ queryKey: ['user-system'] });
    }
  } finally {
    importingDepth = Math.max(0, importingDepth - 1);
    emitStore({ isImporting: false });
  }

  await syncAccountHostConfigs(user, { forceSaveCurrent: true });

  return {
    appliedSettings,
    updatedAgentsCount,
    skippedMissingAgentIds,
    failedAgentIds,
  };
}

export function resetAccountHostConfigsForTests(): void {
  webHealthCache.clear();
  importingDepth = 0;
  activeSyncPromise = null;
  activeSyncAccountKey = null;
  emitStore({
    accountKey: null,
    currentHostId: null,
    hosts: [],
    unsyncedHosts: [],
    isSyncing: false,
    isImporting: false,
    lastSyncedAt: null,
    error: null,
  });
}

export function useAccountHostConfigs() {
  const { isSignedIn, user } = useVibeXAccount();
  const queryClient = useContext(QueryClientContext);
  const state = useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot
  );

  const accountKey = isSignedIn ? resolveAccountStorageKey(user) : null;

  useEffect(() => {
    if (!accountKey || !user) return;
    if (state.accountKey !== accountKey) {
      void syncAccountHostConfigs(user);
    }
  }, [accountKey, state.accountKey, user]);

  useEffect(() => {
    if (typeof window === 'undefined' || !accountKey || !user) return;
    const reloadFromStorage = (event: Event) => {
      if (
        event instanceof StorageEvent &&
        event.key !== null &&
        event.key !== ACCOUNT_HOST_CONFIGS_STORAGE_KEY
      ) {
        return;
      }
      void syncAccountHostConfigs(user);
    };
    window.addEventListener('storage', reloadFromStorage);
    window.addEventListener(ACCOUNT_HOST_CONFIGS_EVENT, reloadFromStorage);
    return () => {
      window.removeEventListener('storage', reloadFromStorage);
      window.removeEventListener(ACCOUNT_HOST_CONFIGS_EVENT, reloadFromStorage);
    };
  }, [accountKey, user]);

  const hosts =
    accountKey && state.accountKey === accountKey ? state.hosts : [];
  const unsyncedHosts =
    accountKey && state.accountKey === accountKey ? state.unsyncedHosts : [];
  const currentHostId =
    accountKey && state.accountKey === accountKey ? state.currentHostId : null;
  const currentHost =
    hosts.find((item) => item.hostId === currentHostId) ?? null;
  const otherHosts = hosts.filter((item) => item.hostId !== currentHostId);

  const hostEntries: AccountHostListEntry[] = [
    ...hosts.map((item) => ({
      hostId: item.hostId,
      hostName: item.hostName,
      kind: item.kind,
      osType: item.osType,
      osArch: item.osArch,
      updatedAt: item.updatedAt,
      isCurrent: item.hostId === currentHostId,
      configSynced: true,
      snapshot: item,
    })),
    ...unsyncedHosts.map((item) => ({
      hostId: item.hostId,
      hostName: item.hostName,
      kind: item.kind,
      osType: item.osType,
      osArch: item.osArch,
      updatedAt: item.updatedAt,
      isCurrent: false,
      configSynced: false,
      snapshot: null,
    })),
  ];

  const syncNow = useCallback(async () => {
    if (!user) return [];
    return syncAccountHostConfigs(user, { forceSaveCurrent: true });
  }, [user]);

  const importFromHost = useCallback(
    async (
      source: AccountHostConfigSnapshot,
      options: ImportHostConfigOptions
    ) => {
      return importHostConfigToCurrentHost({
        user,
        source,
        options,
        queryClient,
      });
    },
    [queryClient, user]
  );

  const removeHost = useCallback(
    async (hostId: string) => {
      await removeSavedAccountHostConfig({ user, hostId });
    },
    [user]
  );

  return {
    accountKey,
    hosts,
    hostEntries,
    currentHost,
    otherHosts,
    isSyncing: Boolean(accountKey) && state.isSyncing,
    isImporting: state.isImporting,
    lastSyncedAt:
      accountKey && state.accountKey === accountKey ? state.lastSyncedAt : null,
    error: accountKey && state.accountKey === accountKey ? state.error : null,
    syncNow,
    importFromHost,
    removeHost,
  };
}

export function AccountHostConfigSyncBridge(): null {
  const { isSignedIn, user } = useVibeXAccount();
  const { config, loading } = useUserSystem();
  const accountKey = isSignedIn ? resolveAccountStorageKey(user) : null;
  const debounceTimerRef = useRef<number | null>(null);
  const userRef = useRef(user);
  userRef.current = user;

  const scheduleAutoSync = useCallback(() => {
    if (!userRef.current) return;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      if (userRef.current) {
        void syncAccountHostConfigs(userRef.current);
      }
    }, AUTO_SYNC_DEBOUNCE_MS);
  }, []);

  // Immediate sync upon login / account identity resolution, and debounced sync when Config changes.
  const hasInitialSyncForAccountRef = useRef<string | null>(null);
  useEffect(() => {
    if (!accountKey || !user || loading || !config) {
      if (!accountKey) {
        hasInitialSyncForAccountRef.current = null;
        resetStoreOnSignOut();
      }
      return;
    }
    if (hasInitialSyncForAccountRef.current !== accountKey) {
      hasInitialSyncForAccountRef.current = accountKey;
      void syncAccountHostConfigs(user);
      return;
    }
    scheduleAutoSync();
  }, [accountKey, config, loading, scheduleAutoSync, user]);

  // Listen for frontend preference changes & Agent enablement/reorder events on the current Host.
  useEffect(() => {
    if (!accountKey || !user) return;
    let disposed = false;
    let unlistenAgents: (() => void) | undefined;

    const handlePreferenceStorage = (event: StorageEvent) => {
      if (
        event.key === ACCOUNT_HOST_CONFIGS_STORAGE_KEY ||
        event.key === 'vibex.account.token'
      ) {
        return;
      }
      scheduleAutoSync();
    };
    const handleSettingsChanged = () => {
      scheduleAutoSync();
    };

    window.addEventListener('storage', handlePreferenceStorage);
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    window.addEventListener('host-client-changed', handleSettingsChanged);
    window.addEventListener('focus', handleSettingsChanged);

    void backendListen<void>('agent-management-snapshot-invalidated', () => {
      if (!disposed) {
        scheduleAutoSync();
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlistenAgents = stop;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlistenAgents?.();
      window.removeEventListener('storage', handlePreferenceStorage);
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChanged);
      window.removeEventListener('host-client-changed', handleSettingsChanged);
      window.removeEventListener('focus', handleSettingsChanged);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [accountKey, scheduleAutoSync, user]);

  return null;
}

function resetStoreOnSignOut(): void {
  void hostTunnelApi.setAccountLease(null).catch(() => undefined);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('vibex:host-tunnel-updated'));
  }
  if (
    storeState.accountKey !== null ||
    storeState.hosts.length > 0 ||
    storeState.unsyncedHosts.length > 0 ||
    storeState.currentHostId !== null
  ) {
    emitStore({
      accountKey: null,
      currentHostId: null,
      hosts: [],
      unsyncedHosts: [],
      isSyncing: false,
      lastSyncedAt: null,
      error: null,
    });
  }
}
