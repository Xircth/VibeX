import { useCallback, useEffect, useState, useRef } from 'react';
import type { Operation } from 'rfc6902';
import { cloneAndApplyUpsertPatch } from '@/utils/jsonPatch';
import { getBackendTransport } from '@/lib/transport/transportRegistry';
import type { RemoteEvent } from '@/lib/transport/backendTransport';
import { randomUUID } from '@/utils/randomUUID';
import type { JsonValue } from 'shared/types';

type TauriLogMsg =
  | { JsonPatch: Operation[] }
  | 'Ready'
  | 'Finished'
  | { Stdout: string }
  | { Stderr: string }
  | { SessionId: string }
  | { MessageId: string };

const STREAM_BY_COMMAND: Record<string, string> = {
  subscribe_projects_stream: 'projects',
  subscribe_project_workspaces_stream: 'project_workspaces',
  subscribe_execution_processes_stream: 'execution_processes',
  subscribe_diff_stream: 'diff',
  subscribe_file_tree_stream: 'file_tree',
  subscribe_scratch_stream: 'scratch',
  subscribe_slash_commands_stream: 'slash_commands',
  subscribe_log_stream: 'log',
  subscribe_conversation_stream: 'conversation',
};

const SNAPSHOT_READY_COMMANDS = new Set<string>([
  'subscribe_projects_stream',
  'subscribe_project_workspaces_stream',
  'subscribe_execution_processes_stream',
  'subscribe_scratch_stream',
]);

const INITIAL_SNAPSHOT_TIMEOUT_MS = 8_000;

export interface TauriPatchStreamOptions<T> {
  subscribeCommand: string;
  subscribeArgs?: Record<string, unknown>;
  eventChannel: string;
  initialData: () => T;
  enabled?: boolean;
  deduplicatePatches?: (patches: Operation[]) => Operation[];
  injectInitialEntry?: (data: T) => void;
}

export interface TauriPatchStreamResult<T> {
  data: T | undefined;
  isConnected: boolean;
  isInitialized: boolean;
  isRetrying: boolean;
  retryCount: number;
  error: string | null;
  retry: () => void;
}

function asLogMsg(payload: unknown): TauriLogMsg | null {
  if (payload === 'Ready' || payload === 'Finished') {
    return payload;
  }
  if (typeof payload === 'object' && payload !== null) {
    return payload as TauriLogMsg;
  }
  return null;
}

function extractStreamErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err.length > 0) {
    return err;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { message: string }).message.length > 0
  ) {
    return (err as { message: string }).message;
  }
  return 'Failed to connect';
}

export const usePatchStream = <T extends object>(
  options: TauriPatchStreamOptions<T>
): TauriPatchStreamResult<T> => {
  const {
    subscribeCommand,
    subscribeArgs,
    eventChannel,
    initialData,
    enabled = true,
    deduplicatePatches,
    injectInitialEntry,
  } = options;

  const [data, setData] = useState<T | undefined>(undefined);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const dataRef = useRef<T | undefined>(undefined);
  const finishedRef = useRef<boolean>(false);
  const isInitializedRef = useRef<boolean>(false);
  const argsKey = subscribeArgs ? JSON.stringify(subscribeArgs) : '';

  const retry = useCallback(() => {
    setRetryNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setIsConnected(false);
      setIsInitialized(false);
      setIsRetrying(false);
      setRetryCount(0);
      setError(null);
      dataRef.current = undefined;
      finishedRef.current = false;
      isInitializedRef.current = false;
      return;
    }

    const init = initialData();
    if (injectInitialEntry) {
      injectInitialEntry(init);
    }
    dataRef.current = init;
    finishedRef.current = false;
    isInitializedRef.current = false;
    setIsRetrying(false);
    setRetryCount(0);

    let cancelled = false;
    let pendingOps: Operation[] = [];
    let flushScheduled = false;

    const flushPendingPatches = () => {
      flushScheduled = false;
      if (cancelled || !pendingOps.length) {
        pendingOps = [];
        return;
      }
      const opsToApply = pendingOps;
      pendingOps = [];
      const current = dataRef.current;
      if (!current) return;
      try {
        const filtered = deduplicatePatches
          ? deduplicatePatches(opsToApply)
          : opsToApply;
        if (!filtered.length) return;
        const next = cloneAndApplyUpsertPatch(current, filtered);
        dataRef.current = next;
        setData(next);
      } catch (err) {
        console.error('Failed to process patch stream message:', err);
        setError('Failed to process stream update');
      }
    };

    const markInitialized = () => {
      if (!isInitializedRef.current) {
        isInitializedRef.current = true;
        setIsInitialized(true);
      }
      if (dataRef.current !== undefined) {
        setData((prev) => (prev === undefined ? dataRef.current : prev));
      }
    };

    const applyMessage = (payload: unknown) => {
      if (cancelled || finishedRef.current) return;
      const msg = asLogMsg(payload);
      if (msg == null) return;
      try {
        if (typeof msg === 'object' && msg !== null && 'JsonPatch' in msg) {
          const patches: Operation[] = msg.JsonPatch;
          const filtered = deduplicatePatches
            ? deduplicatePatches(patches)
            : patches;
          markInitialized();
          if (!filtered.length || !dataRef.current) return;
          pendingOps.push(...filtered);
          if (!flushScheduled) {
            flushScheduled = true;
            queueMicrotask(flushPendingPatches);
          }
          return;
        }
        if (msg === 'Ready') {
          flushPendingPatches();
          markInitialized();
          return;
        }
        if (msg === 'Finished') {
          flushPendingPatches();
          finishedRef.current = true;
          markInitialized();
          setIsConnected(false);
        }
      } catch (err) {
        console.error('Failed to process patch stream message:', err);
        setError('Failed to process stream update');
      }
    };

    let iterator: AsyncIterator<RemoteEvent> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let clearSnapshotWatchdog = () => {};
    let retryAttempts = 0;

    const scheduleReconnect = () => {
      if (cancelled || finishedRef.current || retryTimer !== undefined) {
        return;
      }
      const delay = Math.min(1000 * 2 ** retryAttempts, 10_000);
      retryAttempts += 1;
      setRetryCount(retryAttempts);
      setIsRetrying(true);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!cancelled && !finishedRef.current) {
          setIsRetrying(false);
          void setup(true);
        }
      }, delay);
    };

    const setup = async (isReconnect = false) => {
      if (cancelled || finishedRef.current) {
        return;
      }
      const transport = getBackendTransport();
      const stream = STREAM_BY_COMMAND[subscribeCommand];
      if (!stream || !transport.subscribe) {
        setIsConnected(false);
        setIsRetrying(false);
        setError(`patch stream ${subscribeCommand} is not available`);
        return;
      }
      if (isReconnect) {
        const nextInit = initialData();
        if (injectInitialEntry) {
          injectInitialEntry(nextInit);
        }
        dataRef.current = nextInit;
        finishedRef.current = false;
        isInitializedRef.current = false;
        pendingOps = [];
      }
      const args = (argsKey ? JSON.parse(argsKey) : {}) as JsonValue;
      let currentIterator: AsyncIterator<RemoteEvent> | undefined;
      try {
        const subscription = transport.subscribe({
          subscription_id: randomUUID(),
          resource: 'patch_stream',
          stream,
          args,
        });
        currentIterator = subscription[Symbol.asyncIterator]();
        iterator = currentIterator;
        if (cancelled) {
          void currentIterator.return?.();
          return;
        }
        setIsConnected(true);
        setError(null);
        let sawMessage = false;
        let timedOutWaitingForSnapshot = false;

        const waitForNextEvent = async (): Promise<
          IteratorResult<RemoteEvent> | 'snapshot_timeout'
        > => {
          if (
            isInitializedRef.current ||
            !SNAPSHOT_READY_COMMANDS.has(subscribeCommand)
          ) {
            return currentIterator!.next();
          }
          return new Promise<IteratorResult<RemoteEvent> | 'snapshot_timeout'>(
            (resolve, reject) => {
              const timer = setTimeout(() => {
                resolve('snapshot_timeout');
              }, INITIAL_SNAPSHOT_TIMEOUT_MS);
              clearSnapshotWatchdog = () => {
                clearTimeout(timer);
              };
              currentIterator!.next().then(
                (res) => {
                  clearTimeout(timer);
                  resolve(res);
                },
                (err) => {
                  clearTimeout(timer);
                  reject(err);
                }
              );
            }
          );
        };

        while (!cancelled) {
          const next = await waitForNextEvent();
          if (next === 'snapshot_timeout') {
            timedOutWaitingForSnapshot = true;
            break;
          }
          if (next.done || cancelled) break;
          if (!sawMessage) {
            sawMessage = true;
            retryAttempts = 0;
            setRetryCount(0);
            setIsRetrying(false);
          }
          applyMessage((next.value as RemoteEvent).payload);
        }
        if (!cancelled && !finishedRef.current) {
          setError(
            timedOutWaitingForSnapshot
              ? 'Timed out waiting for initial stream snapshot'
              : 'Stream disconnected unexpectedly'
          );
          scheduleReconnect();
        }
      } catch (err) {
        if (!cancelled) {
          console.error(`Failed to subscribe to ${eventChannel}:`, err);
          setError(extractStreamErrorMessage(err));
          const retryable =
            typeof err === 'object' && err !== null && 'retryable' in err
              ? (err as { retryable?: unknown }).retryable !== false
              : true;
          if (retryable) {
            scheduleReconnect();
          } else {
            setIsRetrying(false);
          }
        }
      } finally {
        clearSnapshotWatchdog();
        void currentIterator?.return?.();
        if (iterator === currentIterator) {
          iterator = undefined;
        }
        if (!cancelled) {
          setIsConnected(false);
        }
      }
    };

    void setup(false);

    return () => {
      cancelled = true;
      clearSnapshotWatchdog();
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      void iterator?.return?.();
      dataRef.current = undefined;
      finishedRef.current = false;
      isInitializedRef.current = false;
      setData(undefined);
      setIsInitialized(false);
      setIsConnected(false);
      setIsRetrying(false);
      setRetryCount(0);
    };
  }, [
    subscribeCommand,
    argsKey,
    eventChannel,
    enabled,
    initialData,
    injectInitialEntry,
    deduplicatePatches,
    retryNonce,
  ]);

  return {
    data,
    isConnected,
    isInitialized,
    isRetrying,
    retryCount,
    error,
    retry,
  };
};
