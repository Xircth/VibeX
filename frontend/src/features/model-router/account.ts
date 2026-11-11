import { getSiteUrl } from '@/lib/branding';
import type { SyncableHostProfile } from '@/lib/api';

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

export type RouterOverview = {
  user: {
    email: string;
    username: string;
    displayName: string;
    tier?: AccountTier;
    createdAt?: string;
  };
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

/** `signed_out` means the token is missing or no longer accepted. */
export class AccountError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AccountError';
  }
}

export const ACCOUNT_TOKEN_EVENT = 'vibex:account-token-changed';

export function accountToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function subscribeAccountToken(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
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
  window.dispatchEvent(new Event(ACCOUNT_TOKEN_EVENT));
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call<T>(
  path: string,
  init: { method: HttpMethod; body?: unknown; token?: string | null }
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let response: Response;
  try {
    response = await fetch(getSiteUrl(path), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AccountError('network');
  }
  if (response.status === 401) {
    if (init.token) storeToken(null);
    throw new AccountError('signed_out');
  }
  if (
    response.status === 404 ||
    response.status === 405 ||
    response.status === 501
  ) {
    throw new AccountError('unsupported');
  }
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok || !payload) {
    throw new AccountError(payload?.error ?? 'failed');
  }
  return payload;
}

function authed<T>(path: string, method: HttpMethod, body?: unknown) {
  const token = accountToken();
  if (!token) return Promise.reject(new AccountError('signed_out'));
  return call<T>(path, { method, body, token });
}

export const accountApi = {
  startLogin: (device?: {
    deviceName?: string;
    hostId?: string;
  }): Promise<DeviceLogin> =>
    call('/api/auth/desktop/start', {
      method: 'POST',
      body: {
        deviceName: device?.deviceName?.trim() || 'VibeX Desktop',
        hostId: device?.hostId?.trim() || '',
      },
    }),

  /** Resolves `true` once the browser approved this device, `false` while it is still waiting. */
  async pollLogin(login: DeviceLogin): Promise<boolean> {
    const result = await call<{ status: string; token?: string }>(
      '/api/auth/desktop/token',
      {
        method: 'POST',
        body: { requestId: login.requestId, verifier: login.verifier },
      }
    );
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
    if (!token) return;
    // The local token is already gone; a failed revoke only leaves a server
    // session the user can still end from the site's security page.
    await call('/api/auth/logout', { method: 'POST', token }).catch(() => null);
  },

  overview: (): Promise<RouterOverview> =>
    authed('/api/modelrouter/desktop', 'GET'),

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

  deleteSavedHost: (selector: SavedHostDeleteSelector): Promise<{
    ok?: boolean;
    deleted?: number;
    savedHosts?: SyncableHostProfile[];
  }> => authed('/api/account/desktop/saved-hosts', 'DELETE', selector),
};

export function modelRouterUrl(agentId: string, modelId: string | null) {
  const query = new URLSearchParams({ agent: agentId });
  if (modelId) query.set('model', modelId);
  return getSiteUrl(`/account/models?${query.toString()}`);
}
