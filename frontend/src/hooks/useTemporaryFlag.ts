import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Returns a boolean flag that auto-resets to `false` after `duration` ms.
 *
 * Usage:
 * ```ts
 * const [copied, triggerCopied] = useTemporaryFlag(2000);
 * // call triggerCopied() to set flag to true; it resets automatically.
 * ```
 *
 * - Re-triggering while active restarts the timer.
 * - The timer is cleaned up on unmount.
 */
export function useTemporaryFlag(duration = 2000): [boolean, () => void] {
  const [flag, setFlag] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const trigger = useCallback(() => {
    clearTimer();
    setFlag(true);
    timerRef.current = setTimeout(() => {
      setFlag(false);
      timerRef.current = null;
    }, duration);
  }, [duration, clearTimer]);

  useEffect(() => {
    return clearTimer;
  }, [clearTimer]);

  return [flag, trigger];
}
