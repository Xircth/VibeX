import { useEffect, useState, useRef } from 'react';
import type { Operation } from 'rfc6902';
import { applyUpsertPatch } from '@/utils/jsonPatch';
import { getBackendTransport } from '@/lib/transport/transportRegistry';
import type { RemoteEvent } from '@/lib/transport/backendTransport';

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
  error: string | null;
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
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<T | undefined>(undefined);
  const finishedRef = useRef<boolean>(false);
  const isInitializedRef = useRef<boolean>(false);
  const argsKey = subscribeArgs ? JSON.stringify(subscribeArgs) : '';

  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setIsConnected(false);
      setIsInitialized(false);
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

    let cancelled = false;

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
          if (!isInitializedRef.current) {
            isInitializedRef.current = true;
            setIsInitialized(true);
          }
          const current = dataRef.current;
          if (!filtered.length || !current) return;
          const next = structuredClone(current);
          applyUpsertPatch(next, filtered);
          dataRef.current = next;
          setData(next);
          return;
        }
        if (msg === 'Ready') {
          if (!isInitializedRef.current) {
            isInitializedRef.current = true;
            setIsInitialized(true);
          }
          return;
        }
        if (msg === 'Finished') {
          finishedRef.current = true;
          if (!isInitializedRef.current) {
            isInitializedRef.current = true;
            setIsInitialized(true);
          }
          setIsConnected(false);
        }
      } catch (err) {
        console.error('Failed to process patch stream message:', err);
        setError('Failed to process stream update');
      }
    };

    const setup = async () => {
      const transport = getBackendTransport();
      const stream = STREAM_BY_COMMAND[subscribeCommand];
      if (!stream || !transport.subscribe) {
        setError(`patch stream ${subscribeCommand} is not available`);
        return;
      }
      const args = argsKey
        ? (JSON.parse(argsKey) as Record<string, unknown>)
        : {};
      try {
        const subscription = transport.subscribe({
          subscription_id: globalThis.crypto.randomUUID(),
          resource: 'patch_stream',
          stream,
          args,
          after_sequence: 0n,
        });
        if (!cancelled) {
          setIsConnected(true);
          setError(null);
        }
        for await (const event of subscription) {
          if (cancelled) return;
          applyMessage((event as RemoteEvent).payload);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(`Failed to subscribe to ${eventChannel}:`, err);
          setError(err instanceof Error ? err.message : 'Failed to connect');
        }
      }
    };

    void setup();

    return () => {
      cancelled = true;
      dataRef.current = undefined;
      finishedRef.current = false;
      isInitializedRef.current = false;
      setData(undefined);
      setIsInitialized(false);
      setIsConnected(false);
    };
  }, [
    subscribeCommand,
    argsKey,
    eventChannel,
    enabled,
    initialData,
    injectInitialEntry,
    deduplicatePatches,
  ]);

  return { data, isConnected, isInitialized, error };
};

/** @deprecated Host Event Bus + patch_stream subscription; same hook. */
export const useTauriPatchStream = usePatchStream;
