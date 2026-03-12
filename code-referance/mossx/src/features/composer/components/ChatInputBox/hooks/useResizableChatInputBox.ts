import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

type ResizeDirection = 'n';

interface SizeState {
  wrapperHeightPx: number | null;
  isCollapsed: boolean;
}

interface Bounds {
  minWrapperHeightPx: number;
  maxWrapperHeightPx: number;
}

// Use v2 key to avoid loading old width values from v1
const STORAGE_KEY = 'chat-input-box:size-v2';

const VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO = 0.55;
const MAX_WRAPPER_HEIGHT_CAP_PX = 520;
const MIN_MAX_WRAPPER_HEIGHT_PX = 140;
const DEFAULT_MIN_WRAPPER_HEIGHT_PX = 112;
const COLLAPSE_OVERSHOOT_PX = 36;
const EXPAND_DRAG_THRESHOLD_PX = 18;
const COLLAPSE_EXPAND_HOLD_MS = 400;
const EXPAND_RESIZE_HOLD_MS = 1000;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function getBounds(): Bounds {
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : VIEWPORT_HEIGHT_FALLBACK_PX;
  // Wrapper height controls the editable scroll region; keep a sane cap so the input doesn't take over the UI.
  const maxWrapperHeightPx = Math.max(
    MIN_MAX_WRAPPER_HEIGHT_PX,
    Math.floor(Math.min(viewportH * MAX_WRAPPER_HEIGHT_VIEWPORT_RATIO, MAX_WRAPPER_HEIGHT_CAP_PX))
  );
  const minWrapperHeightPx = Math.min(DEFAULT_MIN_WRAPPER_HEIGHT_PX, maxWrapperHeightPx);

  return {
    minWrapperHeightPx,
    maxWrapperHeightPx,
  };
}

function sanitizeLoadedSize(raw: unknown): SizeState {
  if (!raw || typeof raw !== 'object') return { wrapperHeightPx: null, isCollapsed: false };
  const obj = raw as Record<string, unknown>;

  let wrapperHeightPx =
    typeof obj.wrapperHeightPx === 'number' && Number.isFinite(obj.wrapperHeightPx) ? obj.wrapperHeightPx : null;

  // Ensure loaded value respects current minimum
  if (wrapperHeightPx !== null && wrapperHeightPx < DEFAULT_MIN_WRAPPER_HEIGHT_PX) {
    wrapperHeightPx = null;
  }

  const isCollapsed = obj.isCollapsed === true;

  return { wrapperHeightPx, isCollapsed };
}

export function computeResize(
  start: { startY: number; startWrapperHeightPx: number },
  current: { y: number },
  bounds: Bounds
): { wrapperHeightPx: number } {
  const dy = current.y - start.startY;
  // Dragging up (dy < 0) increases height.
  const nextHeight = start.startWrapperHeightPx - dy;

  return {
    wrapperHeightPx: clamp(Math.round(nextHeight), bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx),
  };
}

export interface UseResizableChatInputBoxOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  editableWrapperRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * useResizableChatInputBox
 * - Adds pointer-driven resizing (editable-wrapper height only, width is always 100%)
 * - Persists/restores size via localStorage
 */
export function useResizableChatInputBox({
  containerRef: _containerRef,
  editableWrapperRef,
}: UseResizableChatInputBoxOptions): {
  isResizing: boolean;
  isCollapsed: boolean;
  containerStyle: CSSProperties;
  editableWrapperStyle: CSSProperties;
  getHandleProps: (dir: ResizeDirection) => ComponentPropsWithoutRef<'div'>;
  nudge: (delta: { wrapperHeightPx?: number }) => void;
} {
  const [size, setSize] = useState<SizeState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { wrapperHeightPx: null, isCollapsed: false };
      return sanitizeLoadedSize(JSON.parse(raw));
    } catch {
      return { wrapperHeightPx: null, isCollapsed: false };
    }
  });
  const sizeRef = useRef<SizeState>(size);
  sizeRef.current = size;

  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef<{
    startY: number;
    startWrapperHeightPx: number;
    bounds: Bounds;
    prevUserSelect: string;
    prevCursor: string;
    startCollapsed: boolean;
    expandResizeUnlocked: boolean;
  } | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const pendingTransitionRef = useRef<'collapse' | 'expand' | null>(null);
  const expandResizeTimerRef = useRef<number | null>(null);
  const pendingExpandResizeRef = useRef(false);
  const latestPointerYRef = useRef<number | null>(null);

  const clearPendingTransition = useCallback(() => {
    if (transitionTimerRef.current != null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    pendingTransitionRef.current = null;
  }, []);

  const clearPendingExpandResizeUnlock = useCallback(() => {
    if (expandResizeTimerRef.current != null) {
      window.clearTimeout(expandResizeTimerRef.current);
      expandResizeTimerRef.current = null;
    }
    pendingExpandResizeRef.current = false;
  }, []);

  const scheduleExpandResizeUnlock = useCallback(() => {
    if (pendingExpandResizeRef.current) return;

    pendingExpandResizeRef.current = true;
    expandResizeTimerRef.current = window.setTimeout(() => {
      expandResizeTimerRef.current = null;
      pendingExpandResizeRef.current = false;

      const start = startRef.current;
      if (!start) return;

      start.expandResizeUnlocked = true;

      const pointerY = latestPointerYRef.current ?? start.startY;
      const { wrapperHeightPx } = computeResize(
        {
          startY: start.startY,
          startWrapperHeightPx: start.startWrapperHeightPx,
        },
        { y: pointerY },
        start.bounds
      );

      setSize({
        wrapperHeightPx,
        isCollapsed: false,
      });
    }, EXPAND_RESIZE_HOLD_MS);
  }, []);

  const applyTransition = useCallback((intent: 'collapse' | 'expand') => {
    const start = startRef.current;
    const pointerY = start ? latestPointerYRef.current ?? start.startY : null;

    if (intent === 'collapse') {
      if (start && pointerY != null) {
        start.startCollapsed = true;
        start.startY = pointerY;
        start.startWrapperHeightPx = start.bounds.minWrapperHeightPx;
        start.expandResizeUnlocked = true;
      }
      clearPendingExpandResizeUnlock();
      setSize((prev) => (prev.isCollapsed ? prev : { ...prev, isCollapsed: true }));
      return;
    }

    if (!start || pointerY == null) return;

    start.startCollapsed = false;
    start.startY = pointerY;
    start.startWrapperHeightPx = start.bounds.minWrapperHeightPx;
    start.expandResizeUnlocked = false;
    clearPendingExpandResizeUnlock();

    setSize({
      wrapperHeightPx: start.bounds.minWrapperHeightPx,
      isCollapsed: false,
    });
  }, [clearPendingExpandResizeUnlock]);

  const scheduleTransition = useCallback(
    (next: 'collapse' | 'expand' | null) => {
      if (pendingTransitionRef.current === next) return;

      if (transitionTimerRef.current != null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }

      pendingTransitionRef.current = next;
      if (!next) return;

      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null;
        if (pendingTransitionRef.current !== next) return;
        applyTransition(next);
      }, COLLAPSE_EXPAND_HOLD_MS);
    },
    [applyTransition]
  );

  // Persist size changes (best-effort).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    } catch {
      // ignore
    }
  }, [size]);

  // Clamp persisted size on window resize (e.g., user shrinks the tool window).
  useEffect(() => {
    const onResize = () => {
      const bounds = getBounds();
      setSize((prev) => {
        const nextWrapperHeightPx =
          prev.wrapperHeightPx == null
            ? null
            : clamp(prev.wrapperHeightPx, bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx);
        if (nextWrapperHeightPx === prev.wrapperHeightPx) return prev;
        return { ...prev, wrapperHeightPx: nextWrapperHeightPx };
      });
    };

    // Clamp once on mount (handles persisted sizes when the window is smaller/larger).
    onResize();

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const nudge = useCallback(
    (delta: { wrapperHeightPx?: number }) => {
      const bounds = getBounds();
      const wrapperEl = editableWrapperRef.current;
      const wrapperRectHeight = wrapperEl?.getBoundingClientRect().height ?? bounds.minWrapperHeightPx;
      const currentHeight = sizeRef.current.wrapperHeightPx ?? wrapperRectHeight;

      if (sizeRef.current.isCollapsed) {
        if ((delta.wrapperHeightPx ?? 0) <= 0) return;
        const baseHeight = clamp(currentHeight, bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx);
        const nextHeight = clamp(
          Math.round(baseHeight + (delta.wrapperHeightPx ?? 0)),
          bounds.minWrapperHeightPx,
          bounds.maxWrapperHeightPx
        );
        setSize({
          wrapperHeightPx: nextHeight,
          isCollapsed: false,
        });
        return;
      }

      const nextHeight =
        delta.wrapperHeightPx == null
          ? currentHeight
          : clamp(Math.round(currentHeight + delta.wrapperHeightPx), bounds.minWrapperHeightPx, bounds.maxWrapperHeightPx);

      if (
        delta.wrapperHeightPx != null &&
        delta.wrapperHeightPx < 0 &&
        currentHeight <= bounds.minWrapperHeightPx
      ) {
        setSize((prev) => ({ ...prev, isCollapsed: true }));
        return;
      }

      setSize((prev) => ({
        ...prev,
        isCollapsed: false,
        wrapperHeightPx: delta.wrapperHeightPx == null ? prev.wrapperHeightPx : nextHeight,
      }));
    },
    [editableWrapperRef]
  );

  const stopResize = useCallback(() => {
    const start = startRef.current;
    if (!start) return;

    document.body.style.userSelect = start.prevUserSelect;
    document.body.style.cursor = start.prevCursor;

    clearPendingTransition();
    clearPendingExpandResizeUnlock();
    latestPointerYRef.current = null;
    startRef.current = null;
    setIsResizing(false);
  }, [clearPendingExpandResizeUnlock, clearPendingTransition]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      e.preventDefault();
      const dy = e.clientY - start.startY;
      latestPointerYRef.current = e.clientY;

      if (start.startCollapsed) {
        const shouldExpand = dy <= -EXPAND_DRAG_THRESHOLD_PX;
        if (!shouldExpand) {
          scheduleTransition(null);
          setSize((prev) => (prev.isCollapsed ? prev : { ...prev, isCollapsed: true }));
          return;
        }
        scheduleTransition('expand');
        return;
      }

      if (!start.expandResizeUnlocked) {
        const shouldUnlockResize = dy <= -EXPAND_DRAG_THRESHOLD_PX;
        if (shouldUnlockResize) {
          scheduleExpandResizeUnlock();
        } else {
          clearPendingExpandResizeUnlock();
        }

        setSize({
          wrapperHeightPx: start.bounds.minWrapperHeightPx,
          isCollapsed: false,
        });
        return;
      }

      const rawHeight = start.startWrapperHeightPx - dy;
      const shouldCollapse = rawHeight <= start.bounds.minWrapperHeightPx - COLLAPSE_OVERSHOOT_PX;

      if (shouldCollapse) {
        clearPendingExpandResizeUnlock();
        scheduleTransition('collapse');
        return;
      }

      scheduleTransition(null);
      clearPendingExpandResizeUnlock();
      const { wrapperHeightPx } = computeResize(
        {
          startY: start.startY,
          startWrapperHeightPx: start.startWrapperHeightPx,
        },
        { y: e.clientY },
        start.bounds
      );

      setSize({
        wrapperHeightPx,
        isCollapsed: false,
      });
    };

    const onUp = () => stopResize();
    const onCancel = () => stopResize();

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [clearPendingExpandResizeUnlock, scheduleExpandResizeUnlock, scheduleTransition, stopResize]);

  useEffect(() => {
    return () => {
      clearPendingTransition();
      clearPendingExpandResizeUnlock();
    };
  }, [clearPendingExpandResizeUnlock, clearPendingTransition]);

  const getHandleProps = useCallback(
    (_dir: ResizeDirection) => {
      return {
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();

          const bounds = getBounds();
          const wrapperEl = editableWrapperRef.current;
          const wrapperRect = wrapperEl?.getBoundingClientRect();

          const startWrapperHeightPx =
            sizeRef.current.wrapperHeightPx ??
            (wrapperRect?.height ? Math.round(wrapperRect.height) : bounds.minWrapperHeightPx);

          const prevUserSelect = document.body.style.userSelect;
          const prevCursor = document.body.style.cursor;

          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'ns-resize';
          clearPendingTransition();
          clearPendingExpandResizeUnlock();
          latestPointerYRef.current = e.clientY;

          startRef.current = {
            startY: e.clientY,
            startWrapperHeightPx,
            bounds,
            prevUserSelect,
            prevCursor,
            startCollapsed: sizeRef.current.isCollapsed,
            expandResizeUnlocked: !sizeRef.current.isCollapsed,
          };

          setIsResizing(true);
        },
      } satisfies ComponentPropsWithoutRef<'div'>;
    },
    [clearPendingExpandResizeUnlock, clearPendingTransition, editableWrapperRef]
  );

  // containerStyle is now empty - width is always auto (100% of parent)
  const containerStyle = useMemo((): CSSProperties => {
    return {};
  }, []);

  const editableWrapperStyle = useMemo((): CSSProperties => {
    return {
      height: size.isCollapsed || size.wrapperHeightPx == null ? undefined : `${size.wrapperHeightPx}px`,
      maxHeight: size.isCollapsed || size.wrapperHeightPx == null ? undefined : `${size.wrapperHeightPx}px`,
    };
  }, [size.isCollapsed, size.wrapperHeightPx]);

  return {
    isResizing,
    isCollapsed: size.isCollapsed,
    containerStyle,
    editableWrapperStyle,
    getHandleProps,
    nudge,
  };
}
