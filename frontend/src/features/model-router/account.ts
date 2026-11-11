import { getSiteUrl } from '@/lib/branding';

/**
 * The VibeX account lives on the product site. The desktop talks to it
 * straight from the webview with a device token, so the local Host stays
 * account-free and works unchanged offline or signed out.
 */
const TOKEN_KEY = 'vibex.account.token';

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

export type RouterOverview = {
  user: { email: string; username: string; displayName: string };
  balanceMicro: number;
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

export function accountToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

function storeToken(token: string | null) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; token?: string | null }
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
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok || !payload) {
    throw new AccountError(payload?.error ?? 'failed');
  }
  return payload;
}

function authed<T>(path: string, method: 'GET' | 'POST', body?: unknown) {
  const token = accountToken();
  if (!token) return Promise.reject(new AccountError('signed_out'));
  return call<T>(path, { method, body, token });
}

export const accountApi = {
  startLogin: (): Promise<DeviceLogin> =>
    call('/api/auth/desktop/start', {
      method: 'POST',
      body: { deviceName: 'VibeX Desktop' },
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
};

export function modelRouterUrl(agentId: string, modelId: string | null) {
  const query = new URLSearchParams({ agent: agentId });
  if (modelId) query.set('model', modelId);
  return getSiteUrl(`/modelrouter?${query.toString()}`);
}
