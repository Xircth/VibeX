import { useEffect, useState, useRef } from 'react';
import type { PatchType } from 'shared/types';
import { getBackendTransport } from '@/lib/transport/transportRegistry';
import type { RemoteEvent } from '@/lib/transport/backendTransport';

type LogEntry = Extract<PatchType, { type: 'STDOUT' } | { type: 'STDERR' }>;

interface UseLogStreamResult {
  logs: LogEntry[];
  error: string | null;
}

// Tauri event payload shape (matches Rust LogMsg enum with serde default tagging)
type TauriLogMsg =
  | { Stdout: string }
  | { Stderr: string }
  | { JsonPatch: Array<{ value?: PatchType }> }
  | 'Ready'
  | 'Finished';

// Cap retained log entries so a long-running process can't grow the array (and
// its per-append copy cost) without bound; keep the most recent N.
const MAX_LOG_ENTRIES = 5000;

function appendCappedLogs(prev: LogEntry[], next: LogEntry[]): LogEntry[] {
  const merged = [...prev, ...next];
  return merged.length > MAX_LOG_ENTRIES
    ? merged.slice(merged.length - MAX_LOG_ENTRIES)
    : merged;
}

export const useLogStream = (processId: string): UseLogStreamResult => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const currentProcessIdRef = useRef<string>(processId);

  useEffect(() => {
    if (!processId) {
      return;
    }

    currentProcessIdRef.current = processId;
    setLogs([]);
    setError(null);

    let cancelled = false;
    let iterator: AsyncIterator<RemoteEvent> | undefined;

    const applyMessage = (raw: unknown) => {
      if (cancelled || currentProcessIdRef.current !== processId) return;
      const msg = raw as TauriLogMsg;
      try {
        if (typeof msg === 'object' && msg !== null && 'Stdout' in msg) {
          setLogs((prev) =>
            appendCappedLogs(prev, [{ type: 'STDOUT', content: msg.Stdout }])
          );
          return;
        }

        if (typeof msg === 'object' && msg !== null && 'Stderr' in msg) {
          setLogs((prev) =>
            appendCappedLogs(prev, [{ type: 'STDERR', content: msg.Stderr }])
          );
          return;
        }

        if (typeof msg === 'object' && msg !== null && 'JsonPatch' in msg) {
          const patches = msg.JsonPatch;
          const newEntries: LogEntry[] = [];
          for (const patch of patches) {
            const value = patch?.value;
            if (!value || !value.type) continue;
            if (value.type === 'STDOUT' || value.type === 'STDERR') {
              newEntries.push({
                type: value.type,
                content: value.content,
              });
            }
          }
          if (newEntries.length > 0) {
            setLogs((prev) => appendCappedLogs(prev, newEntries));
          }
          return;
        }
      } catch (err) {
        console.error('Failed to process log stream event:', err);
      }
    };

    const setup = async () => {
      const transport = getBackendTransport();
      if (!transport.subscribe) {
        setError('patch stream subscribe_log_stream is not available');
        return;
      }
      try {
        const subscription = transport.subscribe({
          subscription_id: globalThis.crypto.randomUUID(),
          resource: 'patch_stream',
          stream: 'log',
          args: { processId },
        });
        iterator = subscription[Symbol.asyncIterator]();
        if (cancelled) {
          void iterator.return?.();
          return;
        }
        setError(null);
        while (!cancelled) {
          const next = await iterator.next();
          if (next.done || cancelled) break;
          const payload = (next.value as RemoteEvent).payload;
          applyMessage(payload);
          if (payload === 'Finished') break;
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to subscribe to log stream:', err);
          setError(err instanceof Error ? err.message : 'Failed to connect');
        }
      } finally {
        void iterator?.return?.();
      }
    };

    void setup();

    return () => {
      cancelled = true;
      void iterator?.return?.();
    };
  }, [processId]);

  return { logs, error };
};
