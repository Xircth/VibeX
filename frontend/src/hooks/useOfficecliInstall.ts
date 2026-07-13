import { useCallback, useRef, useState } from 'react';
import {
  officeApi,
  OFFICECLI_INSTALL_EVENT,
  type OfficecliInstallEvent,
} from '@/lib/api';
import { tauriListen } from '@/lib/tauriApi';

export type OfficecliInstallStatus =
  | 'idle'
  | 'installing'
  | 'completed'
  | 'failed';

const MAX_LOG_LINES = 200;

/**
 * Run the OfficeCLI installer and stream its log output.
 *
 * The backend tags every `officecli-install` event with the caller's task id,
 * so concurrent installs (e.g. two preview panels racing) don't
 * cross-contaminate each other's logs.
 */
export function useOfficecliInstall() {
  const [status, setStatus] = useState<OfficecliInstallStatus>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const start = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    const taskId = crypto.randomUUID();
    setStatus('installing');
    setLogs([]);
    setError(null);

    const unlisten = await tauriListen<OfficecliInstallEvent>(
      OFFICECLI_INSTALL_EVENT,
      (event) => {
        if (event.task_id !== taskId) {
          return;
        }
        if (event.kind === 'log' && event.payload) {
          setLogs((prev) => [
            ...prev.slice(-(MAX_LOG_LINES - 1)),
            event.payload,
          ]);
        }
      }
    );

    try {
      await officeApi.install(taskId);
      setStatus('completed');
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unlisten();
      inFlightRef.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    setStatus('idle');
    setLogs([]);
    setError(null);
  }, []);

  return { status, logs, error, start, reset };
}
