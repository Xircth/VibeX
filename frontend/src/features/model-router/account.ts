import { getSiteUrl } from '@/lib/branding';
import {
  hostClientApi,
  hostTunnelApi,
  type SyncableHostProfile,
} from '@/lib/api';
import { isTauriClient } from '@/lib/desktopShell';
import {
  readDesktopSharedPreferenceSection,
  writeDesktopSharedPreferenceSection,
} from '@/lib/frontendPreferences';

import { openExternal } from './openExternal';

export type SavedHostDeleteSelector = {
  syncKey?: string;
  hostId?: string;
  profileId?: string;
  origin?: string;
  sshTarget?: string;
};

/**
 * The VibeX account lives on the product site. The desktop talks to it
 * straight from the webview with a device token, so the local Host stays
 * account-free and works unchanged offline or signed out.
 */
export const ACCOUNT_TOKEN_STORAGE_KEY = 'vibex.account.token';
const TOKEN_KEY = ACCOUNT_TOKEN_STORAGE_KEY;

export type RouterModel = {
  id: string;
  name: string;
  vendor: string;
  /** Micro-credits per million tokens at list price. */
  inputMicro: number;
  outputMicro: number;
  /** Share of the list price actually charged, in thousandths. */
  discountPermille: number;
};

export type RouterAgent = {
  id: string;
  name: string;
  /** Model ids, the agent's own family first. */
  native: string[];
  others: string[];
};

export type RouterTask = {
  id: string;
  orderNo: string;
  agentId: string;
  modelId: string;
};

export type AccountTier =
  | 'regular'
  | 'sponsor'
  | 'subscriber'
  | 'beta'
  | 'admin';

export type RouterGrantSource = 'order' | 'promo' | 'admin';

export type RouterCreditGrant = {
  id: string;
  source: RouterGrantSource;
  orderNo: string;
  note: string;
  amountMicro: number;
  remainingMicro: number;
  createdAt: string;
  expiresAt: string;
  voided: boolean;
};

export type RouterModelUsage = {
  modelId: string;
  costMicro: number;
  requests: number;
  tokens: number;
};

export type RouterDailyUsage = {
  day: string;
  costMicro: number;
  requests: number;
  tokens: number;
};

export type RouterUsage30d = {
  byModel: RouterModelUsage[];
  daily: RouterDailyUsage[];
  totalRecords: number;
  modelNames?: Record<string, string>;
};

export type AccountOwnerSummary = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type AssignedRelayServerInfo = {
  id: string;
  name: string;
  region: string;
  relayHost: string;
  relayPort: number;
  publicOrigin: string;
};

export type RouterOverview = {
  user: {
    id?: string;
    email: string;
    username: string;
    displayName: string;
    avatarUrl?: string | null;
    tier?: AccountTier;
    createdAt?: string;
  };
  relayPermission?: boolean;
  assignedRelayServer?: AssignedRelayServerInfo | null;
  balanceMicro: number;
  serverNow?: string;
  grants?: RouterCreditGrant[];
  usage30d?: RouterUsage30d;
  tasks: RouterTask[];
  agents: RouterAgent[];
  models: RouterModel[];
};

export type RouterProvision = {
  apiKey: string;
  agentId: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  model: { id: string; name: string };
  /** Every model this key can reach over `protocol`. */
  models: { id: string; name: string }[];
  group?: string;
  keyName?: string;
};

export type DeviceLogin = {
  requestId: string;
  verifier: string;
  userCode: string;
  verifyUrl: string;
  /** Seconds. */
  expiresIn: number;
  interval: number;
};

export type StartLoginOptions =
  | string
  | {
      deviceName?: string;
      hostId?: string;
      nextPath?: string;
    };

/** `signed_out` means the token is missing or no longer accepted. */
export class AccountError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AccountError';
  }
}

export const ACCOUNT_TOKEN_EVENT = 'vibex:account-token-changed';
export const DESKTOP_SHARED_ACCOUNT_TOKEN_KEY = '__account_token_v1';
export const DESKTOP_SHARED_ACCOUNT_OWNER_KEY = '__account_owner_v1';
export const HOST_BOUND_ACCOUNTS_STORAGE_KEY =
  'vibex.account.hostBoundAccounts.v1';
export const HOST_BOUND_ACCOUNTS_EVENT = 'vibex:host-bound-accounts-changed';
let sharedTokenHydrationStarted = false;
const EMPTY_HOST_BOUND_ACCOUNTS: Record<string, AccountOwnerSummary> =
  Object.freeze({});
let cachedHostBoundAccountsRaw: string | null = null;
let cachedHostBoundAccountsSnapshot: Record<string, AccountOwnerSummary> =
  EMPTY_HOST_BOUND_ACCOUNTS;

export function readHostBoundAccounts(): Record<string, AccountOwnerSummary> {
  if (typeof window === 'undefined') return EMPTY_HOST_BOUND_ACCOUNTS;
  try {
    const raw = window.localStorage.getItem(HOST_BOUND_ACCOUNTS_STORAGE_KEY);
    if (!raw) {
      cachedHostBoundAccountsRaw = null;
      cachedHostBoundAccountsSnapshot = EMPTY_HOST_BOUND_ACCOUNTS;
      return EMPTY_HOST_BOUND_ACCOUNTS;
    }
    if (raw === cachedHostBoundAccountsRaw) {
      return cachedHostBoundAccountsSnapshot;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      cachedHostBoundAccountsRaw = raw;
      cachedHostBoundAccountsSnapshot = EMPTY_HOST_BOUND_ACCOUNTS;
      return EMPTY_HOST_BOUND_ACCOUNTS;
    }
    const result: Record<string, AccountOwnerSummary> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const obj = value as Record<string, unknown>;
      const username =
        typeof obj.username === 'string' ? obj.username.trim() : '';
      if (!username) continue;
      const displayName =
        typeof obj.displayName === 'string' && obj.displayName.trim()
          ? obj.displayName.trim()
          : username;
      const avatarUrl =
        typeof obj.avatarUrl === 'string' && obj.avatarUrl.trim()
          ? obj.avatarUrl.trim()
          : null;
      result[key] = { username, displayName, avatarUrl };
    }
    cachedHostBoundAccountsRaw = raw;
    cachedHostBoundAccountsSnapshot = result;
    return result;
  } catch {
    return EMPTY_HOST_BOUND_ACCOUNTS;
  }
}

export function writeHostBoundAccount(
  keys: Array<string | null | undefined>,
  account: AccountOwnerSummary | null
): void {
  if (typeof window === 'undefined') return;
  const cleanKeys = keys
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter(Boolean);
  if (cleanKeys.length === 0) return;
  const current: Record<string, AccountOwnerSummary> = {
    ...readHostBoundAccounts(),
  };
  let changed = false;
  for (const key of cleanKeys) {
    if (account) {
      const prev = current[key];
      if (
        !prev ||
        prev.username !== account.username ||
        prev.displayName !== account.displayName ||
        prev.avatarUrl !== account.avatarUrl
      ) {
        current[key] = account;
        changed = true;
      }
    } else if (key in current) {
      delete current[key];
      changed = true;
    }
  }
  if (!changed) return;
  const serialized = JSON.stringify(current);
  cachedHostBoundAccountsRaw = serialized;
  cachedHostBoundAccountsSnapshot = current;
  window.localStorage.setItem(HOST_BOUND_ACCOUNTS_STORAGE_KEY, serialized);
  window.dispatchEvent(new Event(HOST_BOUND_ACCOUNTS_EVENT));
}

export function resolveProfileBoundAccount(
  profile: {
    id?: string | null;
    profileId?: string | null;
    host_id?: string | null;
    hostId?: string | null;
    origin?: string | null;
  },
  map: Record<string, AccountOwnerSummary> = readHostBoundAccounts()
): AccountOwnerSummary | null {
  const rawHostId = (profile.host_id ?? profile.hostId ?? '')
    .trim()
    .replace(/^host:/, '');
  const rawId = (profile.id ?? profile.profileId ?? '').trim();
  const rawOrigin = (profile.origin ?? '').trim().replace(/\/+$/, '');
  const candidates = [
    rawHostId ? `host:${rawHostId}` : '',
    rawHostId,
    rawId ? `profile:${rawId}` : '',
    rawId,
    rawOrigin ? `origin:${rawOrigin}` : '',
    rawOrigin,
  ].filter(Boolean);
  for (const key of candidates) {
    if (map[key]) return map[key]!;
  }
  return null;
}

export function subscribeHostBoundAccounts(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === HOST_BOUND_ACCOUNTS_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener(HOST_BOUND_ACCOUNTS_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(HOST_BOUND_ACCOUNTS_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

function hydrateSharedAccountTokenOnce(): void {
  if (sharedTokenHydrationStarted || typeof window === 'undefined') return;
  sharedTokenHydrationStarted = true;
  const existingLocal = window.localStorage.getItem(TOKEN_KEY);
  if (existingLocal && existingLocal.trim()) {
    void writeDesktopSharedPreferenceSection(
      DESKTOP_SHARED_ACCOUNT_TOKEN_KEY,
      existingLocal.trim()
    );
    return;
  }
  void readDesktopSharedPreferenceSection<string | { token?: string }>(
    DESKTOP_SHARED_ACCOUNT_TOKEN_KEY
  ).then((shared) => {
    const candidate =
      typeof shared === 'string'
        ? shared.trim()
        : typeof shared?.token === 'string'
          ? shared.token.trim()
          : '';
    if (!candidate) return;
    if (!window.localStorage.getItem(TOKEN_KEY)) {
      window.localStorage.setItem(TOKEN_KEY, candidate);
      window.dispatchEvent(new Event(ACCOUNT_TOKEN_EVENT));
    }
  });
}

export function accountToken(): string | null {
  if (typeof window === 'undefined') return null;
  const current = window.localStorage.getItem(TOKEN_KEY);
  if (!current) {
    hydrateSharedAccountTokenOnce();
  }
  return current;
}

export function subscribeAccountToken(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  hydrateSharedAccountTokenOnce();
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TOKEN_KEY) listener();
  };
  window.addEventListener(ACCOUNT_TOKEN_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ACCOUNT_TOKEN_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

function storeToken(token: string | null) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
  void writeDesktopSharedPreferenceSection(
    DESKTOP_SHARED_ACCOUNT_TOKEN_KEY,
    token ?? ''
  );
  if (!token) {
    void writeDesktopSharedPreferenceSection(
      DESKTOP_SHARED_ACCOUNT_OWNER_KEY,
      null
    );
  }
  window.dispatchEvent(new Event(ACCOUNT_TOKEN_EVENT));
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call<T>(
  path: string,
  init: {
    method: HttpMethod;
    body?: unknown;
    token?: string | null;
    preserveTokenOn401?: boolean;
    signal?: AbortSignal;
  }
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let response: Response;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 15_000);
  try {
    response = await fetch(getSiteUrl(path), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (response.status === 401) {
      if (init.token && !init.preserveTokenOn401) storeToken(null);
      throw new AccountError('signed_out');
    }
    if (
      response.status === 404 ||
      response.status === 405 ||
      response.status === 501
    ) {
      throw new AccountError('unsupported');
    }
    const payload = (await response.json()) as (T & { error?: string }) | null;
    if (!response.ok || !payload) {
      throw new AccountError(payload?.error ?? 'failed');
    }
    return payload;
  } catch (cause) {
    if (cause instanceof AccountError) throw cause;
    throw new AccountError('network');
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

function authed<T>(path: string, method: HttpMethod, body?: unknown) {
  const token = accountToken();
  if (!token) return Promise.reject(new AccountError('signed_out'));
  return call<T>(path, { method, body, token });
}

function normalizeNextPath(nextPath?: string): string {
  const trimmed = nextPath?.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return '/account';
  }
  return trimmed;
}

export const accountApi = {
  startLogin: (options?: StartLoginOptions): Promise<DeviceLogin> => {
    const resolved =
      typeof options === 'string' ? { nextPath: options } : (options ?? {});
    return call('/api/auth/desktop/start', {
      method: 'POST',
      body: {
        deviceName: resolved.deviceName?.trim() || 'VibeX Desktop',
        hostId: resolved.hostId?.trim() || '',
        nextPath: normalizeNextPath(resolved.nextPath),
      },
    });
  },

  /** Resolves `true` once the browser approved this device, `false` while it is still waiting. */
  async pollLogin(login: DeviceLogin, signal?: AbortSignal): Promise<boolean> {
    const result = await call<{ status: string; token?: string }>(
      '/api/auth/desktop/token',
      {
        method: 'POST',
        body: { requestId: login.requestId, verifier: login.verifier },
        signal,
      }
    );
    if (signal?.aborted) return false;
    if (result.status === 'approved' && result.token) {
      storeToken(result.token);
      return true;
    }
    if (result.status === 'pending') return false;
    throw new AccountError(result.status);
  },

  async signOut(): Promise<void> {
    const token = accountToken();
    storeToken(null);
    void hostTunnelApi.setAccountLease(null).catch(() => null);
    if (isTauriClient()) {
      void hostClientApi.setSyncAccount(null).catch(() => null);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('vibex:host-tunnel-updated'));
    }
    if (!token) return;
    // The local token is already gone; a failed revoke only leaves a server
    // session the user can still end from the site's security page.
    await call('/api/auth/logout', { method: 'POST', token }).catch(() => null);
  },

  overview: (): Promise<RouterOverview> =>
    authed('/api/modelrouter/desktop', 'GET'),

  overviewWithToken: (token: string): Promise<RouterOverview> =>
    call('/api/modelrouter/desktop', {
      method: 'GET',
      token: token.trim(),
      preserveTokenOn401: true,
    }),

  provision: (
    agentId: string,
    modelId: string,
    taskId: string | null
  ): Promise<RouterProvision> =>
    authed('/api/modelrouter/desktop', 'POST', {
      agentId,
      modelId,
      taskId: taskId ?? '',
    }),

  webHandoff: (
    targetPath: string
  ): Promise<{ handoffUrl: string; expiresIn?: number }> =>
    authed('/api/auth/desktop/web-handoff', 'POST', {
      targetPath: normalizeNextPath(targetPath),
    }),

  async redeemImportTicket(ticket: string): Promise<RouterProvision> {
    const trimmed = ticket.trim();
    if (!trimmed) {
      throw new AccountError('invalid_ticket');
    }
    const token = accountToken();
    try {
      return await call<RouterProvision>('/api/modelrouter/desktop/redeem', {
        method: 'POST',
        body: { ticket: trimmed },
        token,
        preserveTokenOn401: true,
      });
    } catch (error) {
      if (
        token &&
        error instanceof AccountError &&
        error.code === 'signed_out'
      ) {
        return call<RouterProvision>('/api/modelrouter/desktop/redeem', {
          method: 'POST',
          body: { ticket: trimmed },
          preserveTokenOn401: true,
        });
      }
      throw error;
    }
  },

  listHostConfigs: (): Promise<{ hosts: unknown[]; records?: unknown[] }> =>
    authed('/api/account/desktop/host-configs', 'GET'),

  saveHostConfig: (
    snapshot: unknown
  ): Promise<{ ok?: boolean; snapshot?: unknown }> =>
    authed('/api/account/desktop/host-configs', 'PUT', { snapshot }),

  deleteHostConfig: (hostId: string): Promise<{ ok?: boolean }> =>
    authed('/api/account/desktop/host-configs', 'DELETE', { hostId }),

  listSavedHosts: (): Promise<{ savedHosts: SyncableHostProfile[] }> =>
    authed('/api/account/desktop/saved-hosts', 'GET'),

  putSavedHosts: (
    profiles: SyncableHostProfile[]
  ): Promise<{
    ok?: boolean;
    saved?: number;
    skipped?: number;
    savedHosts?: SyncableHostProfile[];
  }> => authed('/api/account/desktop/saved-hosts', 'PUT', { profiles }),

  deleteSavedHost: (
    selector: SavedHostDeleteSelector
  ): Promise<{
    ok?: boolean;
    deleted?: number;
    savedHosts?: SyncableHostProfile[];
  }> => authed('/api/account/desktop/saved-hosts', 'DELETE', selector),

  issueRelayLease: (input: {
    hostId: string;
    hostName?: string;
    osType?: string;
    osArch?: string;
  }): Promise<{
    leaseToken: string;
    expiresAt: number;
    relayHost: string;
    relayPort: number;
    tenantOrigin: string;
    hostId: string;
    leaseVersion: number;
    serverId?: string;
    serverName?: string;
    serverRegion?: string;
  }> => authed('/api/account/relay/lease', 'POST', input),
};

export function modelMarketplacePath(
  agentId?: string | null,
  modelId?: string | null
) {
  const query = new URLSearchParams();
  if (agentId?.trim()) query.set('agent', agentId.trim());
  if (modelId?.trim()) query.set('model', modelId.trim());
  const search = query.toString();
  return search ? `/account/models?${search}` : '/account/models';
}

export function modelRouterUrl(agentId: string, modelId: string | null) {
  return getSiteUrl(modelMarketplacePath(agentId, modelId));
}

export async function openAccountWebPath(
  targetPath = '/account'
): Promise<string> {
  const normalized = normalizeNextPath(targetPath);
  const fallbackUrl = getSiteUrl(normalized);
  if (accountToken()) {
    try {
      const handoff = await accountApi.webHandoff(normalized);
      if (handoff?.handoffUrl) {
        await openExternal(handoff.handoffUrl);
        return handoff.handoffUrl;
      }
    } catch {
      // Fall back to direct URL if handoff fails or token expired
    }
  }
  await openExternal(fallbackUrl);
  return fallbackUrl;
}

export async function openModelMarketplace(
  agentId?: string | null,
  modelId?: string | null
): Promise<string> {
  return openAccountWebPath(modelMarketplacePath(agentId, modelId));
}
