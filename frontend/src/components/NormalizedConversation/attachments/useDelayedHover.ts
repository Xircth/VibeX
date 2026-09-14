import { useCallback, useEffect, useRef, useState } from 'react';
import { HOVER_OPEN_DELAY_MS } from './AttachmentFileCard';

export function useDelayedHover(delayMs = HOVER_OPEN_DELAY_MS) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const enter = useCallback(
    (id: string) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setActiveId(id);
        timerRef.current = null;
      }, delayMs);
    },
    [clearTimer, delayMs]
  );

  const leave = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setActiveId(null);
      timerRef.current = null;
    }, delayMs);
  }, [clearTimer, delayMs]);

  return { activeId, enter, leave };
}
