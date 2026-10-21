import { useCallback, useEffect, useRef, useState } from 'react';

const TEXT_SETTLE_MS = 350;

/**
 * Writes the newest settings value and drops older in-flight edits.
 * Text uses a short settle so a half-typed value is not committed; `flush`
 * writes it when the field is left.
 */
export function useLiveSettingsCommit<T>(save: (value: T) => Promise<void>) {
  const saveRef = useRef(save);
  saveRef.current = save;
  const pending = useRef<{ value: T } | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const scheduled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);
  const [holding, setHolding] = useState(false);

  const setHoldingState = (value: boolean) => {
    holdingRef.current = value;
    setHolding(value);
  };

  const pump = useCallback(() => {
    if (inflight.current) return inflight.current;
    const run = async () => {
      setHoldingState(true);
      try {
        while (pending.current) {
          const next = pending.current.value;
          pending.current = null;
          try {
            await saveRef.current(next);
          } catch (error) {
            console.error('Failed to apply settings', error);
          }
        }
      } finally {
        inflight.current = null;
        if (pending.current) {
          void pump();
        } else if (!timer.current) {
          setHoldingState(false);
        }
      }
    };
    const task = run();
    inflight.current = task;
    return task;
  }, []);

  const schedule = useCallback(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      void pump();
    });
  }, [pump]);

  const writeNow = useCallback(
    (value: T) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = { value };
      setHoldingState(true);
      schedule();
    },
    [schedule]
  );

  const writeSettled = useCallback(
    (value: T) => {
      pending.current = { value };
      setHoldingState(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        schedule();
      }, TEXT_SETTLE_MS);
    },
    [schedule]
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    let guard = 0;
    while (
      (pending.current || inflight.current || scheduled.current) &&
      guard < 5
    ) {
      scheduled.current = false;
      await pump();
      guard += 1;
    }
  }, [pump]);

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (pending.current) void pump();
    };
  }, [pump]);

  return { writeNow, writeSettled, flush, holding, holdingRef };
}
