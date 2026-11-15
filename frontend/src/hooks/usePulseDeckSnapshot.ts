import { useCallback, useContext, useEffect, useState } from 'react';
import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from '@tanstack/react-query';
import { pulseApi, type PulseDeckSnapshot } from '@/lib/api/pulse';
import { backendListen } from '@/lib/backendTransport';

export const PULSE_DECK_CHANGED_EVENT = 'vibex://pulse-deck-changed' as const;
export const PULSE_DECK_SNAPSHOT_QUERY_ROOT = 'pulseDeckSnapshot' as const;

export function formatPulseErrorMessage(
  error: unknown,
  fallback = 'Pulse request failed.'
): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'reason']) {
      const val = record[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    }
  }
  return fallback;
}

export function pulseDeckSnapshotQueryKey(projectId?: string | null) {
  return [PULSE_DECK_SNAPSHOT_QUERY_ROOT, projectId ?? 'all'] as const;
}

type PushListenerEntry = {
  refCount: number;
  cancelled: boolean;
  unlisten: (() => void) | null;
};

const pushListenersByClient = new WeakMap<QueryClient, PushListenerEntry>();

function retainPulseDeckPushListener(queryClient: QueryClient): () => void {
  const existing = pushListenersByClient.get(queryClient);
  if (existing) {
    existing.refCount += 1;
    return () => releasePulseDeckPushListener(queryClient);
  }

  const entry: PushListenerEntry = {
    refCount: 1,
    cancelled: false,
    unlisten: null,
  };
  pushListenersByClient.set(queryClient, entry);

  void backendListen(PULSE_DECK_CHANGED_EVENT, () => {
    void queryClient.invalidateQueries({
      queryKey: [PULSE_DECK_SNAPSHOT_QUERY_ROOT],
    });
  })
    .then((dispose) => {
      if (entry.cancelled) {
        dispose();
      } else {
        entry.unlisten = dispose;
      }
    })
    .catch(() => {
      // Non-fatal in unit tests or offline environments without active push stream.
    });

  return () => releasePulseDeckPushListener(queryClient);
}

function releasePulseDeckPushListener(queryClient: QueryClient) {
  const entry = pushListenersByClient.get(queryClient);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.cancelled = true;
    entry.unlisten?.();
    entry.unlisten = null;
    pushListenersByClient.delete(queryClient);
  }
}

export interface UsePulseDeckSnapshotOptions {
  enabled?: boolean;
}

export function usePulseDeckSnapshot(
  projectId?: string | null,
  options?: UsePulseDeckSnapshotOptions
) {
  const contextQueryClient = useContext(QueryClientContext);
  const [standaloneClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: 0,
            staleTime: 0,
          },
        },
      })
  );
  const effectiveClient = contextQueryClient ?? standaloneClient;
  const hasSharedProvider = Boolean(contextQueryClient);
  const queryKey = pulseDeckSnapshotQueryKey(projectId);

  useEffect(() => {
    if (options?.enabled === false) return undefined;
    return retainPulseDeckPushListener(effectiveClient);
  }, [effectiveClient, options?.enabled]);

  const query = useQuery<PulseDeckSnapshot | null, Error>(
    {
      queryKey,
      queryFn: async () => {
        const snapshot = await pulseApi.deckSnapshot(projectId ?? null);
        return snapshot ?? null;
      },
      enabled: options?.enabled ?? true,
      staleTime: hasSharedProvider ? 10_000 : 0,
      refetchInterval: hasSharedProvider ? 30_000 : false,
      refetchIntervalInBackground: false,
      retry: hasSharedProvider ? 1 : false,
      meta: { suppressGlobalError: true },
    },
    effectiveClient
  );

  const setSnapshotData = useCallback(
    (
      updater:
        | PulseDeckSnapshot
        | null
        | ((
            prev: PulseDeckSnapshot | null | undefined
          ) => PulseDeckSnapshot | null | undefined)
    ) => {
      effectiveClient.setQueryData(queryKey, updater);
    },
    [effectiveClient, queryKey]
  );

  const invalidateSnapshot = useCallback(
    () =>
      effectiveClient.invalidateQueries({
        queryKey: [PULSE_DECK_SNAPSHOT_QUERY_ROOT],
      }),
    [effectiveClient]
  );

  return {
    ...query,
    snapshot: query.data ?? null,
    setSnapshotData,
    invalidateSnapshot,
  };
}
