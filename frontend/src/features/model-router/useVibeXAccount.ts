import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  accountApi,
  accountToken,
  subscribeAccountToken,
  type RouterOverview,
} from './account';

export function useAccountToken(): string | null {
  return useSyncExternalStore(
    subscribeAccountToken,
    accountToken,
    () => null
  );
}

export function resolveAccountDisplayName(
  user?: RouterOverview['user'] | null
): string {
  if (!user) return '';
  return (
    user.displayName?.trim() ||
    user.username?.trim() ||
    user.email?.split('@')[0]?.trim() ||
    ''
  );
}

export function resolveAccountAvatarLabel(
  user?: RouterOverview['user'] | null
): string {
  const name = resolveAccountDisplayName(user);
  if (!name) return '';
  return Array.from(name)[0]?.toUpperCase() ?? '';
}

type AccountSnapshot = {
  token: string | null;
  overview: RouterOverview | null;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  updatedAt: number;
};

const STALE_MS = 60_000;

let snapshot: AccountSnapshot = {
  token: null,
  overview: null,
  isLoading: false,
  isFetching: false,
  error: null,
  updatedAt: 0,
};

let inflight: Promise<RouterOverview | null> | null = null;
let inflightToken: string | null = null;
const listeners = new Set<() => void>();

function emitSnapshot(next: Partial<AccountSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) {
    listener();
  }
}

function subscribeSnapshot(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): AccountSnapshot {
  return snapshot;
}

export async function refreshAccountOverview(options?: {
  force?: boolean;
}): Promise<RouterOverview | null> {
  const currentToken = accountToken();
  if (!currentToken) {
    inflight = null;
    inflightToken = null;
    if (
      snapshot.token !== null ||
      snapshot.overview !== null ||
      snapshot.isLoading ||
      snapshot.isFetching
    ) {
      emitSnapshot({
        token: null,
        overview: null,
        isLoading: false,
        isFetching: false,
        error: null,
        updatedAt: 0,
      });
    }
    return null;
  }

  const fresh =
    !options?.force &&
    snapshot.token === currentToken &&
    snapshot.overview !== null &&
    Date.now() - snapshot.updatedAt < STALE_MS;
  if (fresh) {
    return snapshot.overview;
  }

  if (inflight && inflightToken === currentToken) {
    return inflight;
  }

  const hasExistingOverview =
    snapshot.token === currentToken && snapshot.overview !== null;
  emitSnapshot({
    token: currentToken,
    overview: hasExistingOverview ? snapshot.overview : null,
    isLoading: !hasExistingOverview,
    isFetching: true,
    error: null,
  });

  inflightToken = currentToken;
  inflight = accountApi
    .overview()
    .then((data) => {
      if (accountToken() === currentToken) {
        emitSnapshot({
          token: currentToken,
          overview: data,
          isLoading: false,
          isFetching: false,
          error: null,
          updatedAt: Date.now(),
        });
      }
      return data;
    })
    .catch((cause) => {
      const latestToken = accountToken();
      emitSnapshot({
        token: latestToken,
        overview: latestToken === currentToken ? snapshot.overview : null,
        isLoading: false,
        isFetching: false,
        error: cause,
      });
      return null;
    })
    .finally(() => {
      if (inflightToken === currentToken) {
        inflight = null;
        inflightToken = null;
      }
    });

  return inflight;
}

export function resetAccountOverviewCache(): void {
  inflight = null;
  inflightToken = null;
  emitSnapshot({
    token: null,
    overview: null,
    isLoading: false,
    isFetching: false,
    error: null,
    updatedAt: 0,
  });
}

export function useVibeXAccount() {
  const token = useAccountToken();
  const state = useSyncExternalStore(
    subscribeSnapshot,
    getSnapshot,
    getSnapshot
  );
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!token) {
      resetAccountOverviewCache();
      return;
    }
    void refreshAccountOverview();
  }, [token]);

  const refresh = useCallback(async () => {
    return refreshAccountOverview({ force: true });
  }, []);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await accountApi.signOut();
      resetAccountOverviewCache();
    } finally {
      setSigningOut(false);
    }
  }, []);

  const overview =
    token && state.token === token ? state.overview : null;
  const isLoading =
    Boolean(token) && (state.isLoading || (state.token !== token && !overview));

  return {
    token,
    isSignedIn: Boolean(token),
    overview,
    user: overview?.user ?? null,
    isLoading,
    isFetching: Boolean(token) && state.isFetching,
    error: state.error,
    signingOut,
    refresh,
    signOut,
  };
}
