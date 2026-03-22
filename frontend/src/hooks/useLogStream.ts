import { useEffect, useState, useRef } from 'react';
import type { PatchType } from 'shared/types';
import { tauriInvoke, tauriListen } from '@/lib/tauriApi';

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

export const useLogStream = (processId: string): UseLogStreamResult => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Track current processId to prevent stale events from contaminating logs
  const currentProcessIdRef = useRef<string>(processId);

  useEffect(() => {
    if (!processId) {
      return;
    }

    // Update the ref to track the current processId
    currentProcessIdRef.current = processId;

    // Clear logs when process changes
    setLogs([]);
    setError(null);

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        // 1. Start listening BEFORE invoking the subscribe command
        //    so we don't miss events emitted immediately after.
        unlisten = await tauriListen<TauriLogMsg>(
          `log-stream:${processId}`,
          (msg) => {
            if (cancelled || currentProcessIdRef.current !== processId) return;

            try {
              // Handle Stdout
              if (typeof msg === 'object' && msg !== null && 'Stdout' in msg) {
                setLogs((prev) => [
                  ...prev,
                  { type: 'STDOUT', content: msg.Stdout },
                ]);
                return;
              }

              // Handle Stderr
              if (typeof msg === 'object' && msg !== null && 'Stderr' in msg) {
                setLogs((prev) => [
                  ...prev,
                  { type: 'STDERR', content: msg.Stderr },
                ]);
                return;
              }

              // Handle JsonPatch (batch of log entries)
              if (
                typeof msg === 'object' &&
                msg !== null &&
                'JsonPatch' in msg
              ) {
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
                  setLogs((prev) => [...prev, ...newEntries]);
                }
                return;
              }

              // Handle Finished â€?no further events expected
              if (msg === 'Finished') {
                return;
              }
            } catch (err) {
              console.error('Failed to process log stream event:', err);
            }
          }
        );

        if (cancelled) {
          unlisten?.();
          return;
        }

        // 2. Invoke the subscribe command to start the backend stream.
        await tauriInvoke('subscribe_log_stream', { processId });

        if (!cancelled) {
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to subscribe to log stream:', err);
          setError(
            err instanceof Error ? err.message : 'Failed to connect'
          );
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [processId]);

  return { logs, error };
};
