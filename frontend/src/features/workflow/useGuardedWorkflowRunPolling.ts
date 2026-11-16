import { useEffect, useRef } from 'react';

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export type GuardedWorkflowRunPollingOptions = {
  runId: string | null | undefined;
  status: string | null | undefined;
  refresh: (runId: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
};

/**
 * Polls a live workflow run on a fixed cadence (default 1500ms) while:
 * 1. Guarding with an in-flight lock so slow RPCs never overlap.
 * 2. Pausing background ticks while `document.visibilityState === 'hidden'`.
 * 3. Immediately refreshing when the tab returns to `'visible'`.
 */
export function useGuardedWorkflowRunPolling({
  runId,
  status,
  refresh,
  onError,
  intervalMs = 1500,
}: GuardedWorkflowRunPollingOptions) {
  const inFlightRef = useRef(false);
  const refreshRef = useRef(refresh);
  const onErrorRef = useRef(onError);
  refreshRef.current = refresh;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!runId || (status != null && TERMINAL_STATUSES.has(status))) {
      return;
    }

    let cancelled = false;

    const tick = () => {
      if (cancelled || inFlightRef.current) return;
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      inFlightRef.current = true;
      void refreshRef
        .current(runId)
        .catch((error) => {
          if (!cancelled) {
            onErrorRef.current?.(error);
          }
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    const handleVisibilityChange = () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        tick();
      }
    };

    const timer = window.setInterval(tick, intervalMs);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange
        );
      }
    };
  }, [intervalMs, runId, status]);
}
