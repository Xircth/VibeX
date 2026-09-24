import {
  useCallback,
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { OverlayRect } from '@/lib/nativeSurfaceOverlay';

export type { OverlayRect };

export interface NativeSurfaceOcclusion {
  /** Hide the entire native surface (tab context menu, explicit holds). */
  hide: boolean;
  /** Popover rectangles that should hide the native page so HTML can stack above it. */
  rects: OverlayRect[];
}

type NativeSurfaceOcclusionListener = (
  occlusion: NativeSurfaceOcclusion
) => void;

interface WorkspaceOverlayContextValue {
  setTabCreationMenuOpen: (open: boolean) => void;
  /** Hide native browser surfaces while an HTML overlay (select, menu) is open. */
  setHtmlOverlayOpen: (open: boolean) => void;
  setHtmlOverlayRect: (id: string, rect: OverlayRect | null) => void;
  subscribeNativeSurfaceOcclusion: (
    listener: NativeSurfaceOcclusionListener
  ) => () => void;
  /** Browser panels that own a native HWND. Menus wait for these to step aside. */
  registerNativeSurfaceHost: () => () => void;
  /** Resolve menus waiting to paint above a native page. */
  ackOverlayReady: () => void;
  /** Resolves after native hosts have hidden, or immediately when none are mounted. */
  waitForOverlayReady: () => Promise<void>;
  isOverlayReady: () => boolean;
}

const EMPTY_OCCLUSION: NativeSurfaceOcclusion = { hide: false, rects: [] };

function occlusionEqual(
  left: NativeSurfaceOcclusion,
  right: NativeSurfaceOcclusion
): boolean {
  if (left.hide !== right.hide || left.rects.length !== right.rects.length) {
    return false;
  }
  return left.rects.every((rect, index) => {
    const other = right.rects[index];
    return (
      other != null &&
      rect.x === other.x &&
      rect.y === other.y &&
      rect.width === other.width &&
      rect.height === other.height
    );
  });
}

const OVERLAY_READY_TIMEOUT_MS = 120;

export const WorkspaceOverlayContext =
  createContext<WorkspaceOverlayContextValue>({
    setTabCreationMenuOpen: () => {},
    setHtmlOverlayOpen: () => {},
    setHtmlOverlayRect: () => {},
    subscribeNativeSurfaceOcclusion: (listener) => {
      listener(EMPTY_OCCLUSION);
      return () => {};
    },
    registerNativeSurfaceHost: () => () => {},
    ackOverlayReady: () => {},
    waitForOverlayReady: () => Promise.resolve(),
    isOverlayReady: () => true,
  });

export function WorkspaceOverlayProvider({
  children,
  nativeSurfaceOccluded = false,
}: {
  children: ReactNode;
  nativeSurfaceOccluded?: boolean;
}) {
  const nativeSurfaceOccludedRef = useRef(nativeSurfaceOccluded);
  const tabCreationMenuOpenRef = useRef(false);
  const htmlOverlayCountRef = useRef(0);
  const overlayRectsRef = useRef(new Map<string, OverlayRect>());
  const currentOcclusionRef = useRef<NativeSurfaceOcclusion>({
    hide: nativeSurfaceOccluded,
    rects: [],
  });
  const listenersRef = useRef(new Set<NativeSurfaceOcclusionListener>());
  const surfaceHostCountRef = useRef(0);
  const overlayEpochRef = useRef(0);
  const ackedEpochRef = useRef(0);
  const overlayWaitersRef = useRef<Array<() => void>>([]);

  const flushOverlayWaiters = useCallback(() => {
    const waiters = overlayWaitersRef.current;
    overlayWaitersRef.current = [];
    for (const waiter of waiters) waiter();
  }, []);

  const publishOcclusion = useCallback(() => {
    const nextOcclusion: NativeSurfaceOcclusion = {
      hide:
        nativeSurfaceOccludedRef.current ||
        tabCreationMenuOpenRef.current ||
        htmlOverlayCountRef.current > 0,
      rects: Array.from(overlayRectsRef.current.values()),
    };
    if (occlusionEqual(currentOcclusionRef.current, nextOcclusion)) return;

    currentOcclusionRef.current = nextOcclusion;
    overlayEpochRef.current += 1;
    for (const listener of listenersRef.current) {
      listener(nextOcclusion);
    }
    if (surfaceHostCountRef.current === 0) {
      ackedEpochRef.current = overlayEpochRef.current;
      flushOverlayWaiters();
    }
  }, [flushOverlayWaiters]);

  const setTabCreationMenuOpen = useCallback(
    (open: boolean) => {
      tabCreationMenuOpenRef.current = open;
      publishOcclusion();
    },
    [publishOcclusion]
  );

  const setHtmlOverlayOpen = useCallback(
    (open: boolean) => {
      htmlOverlayCountRef.current = Math.max(
        0,
        htmlOverlayCountRef.current + (open ? 1 : -1)
      );
      publishOcclusion();
    },
    [publishOcclusion]
  );

  const setHtmlOverlayRect = useCallback(
    (id: string, rect: OverlayRect | null) => {
      const overlays = overlayRectsRef.current;
      if (rect == null) {
        if (!overlays.delete(id)) return;
      } else {
        const previous = overlays.get(id);
        if (
          previous &&
          previous.x === rect.x &&
          previous.y === rect.y &&
          previous.width === rect.width &&
          previous.height === rect.height
        ) {
          return;
        }
        overlays.set(id, rect);
      }
      publishOcclusion();
    },
    [publishOcclusion]
  );

  const subscribeNativeSurfaceOcclusion = useCallback(
    (listener: NativeSurfaceOcclusionListener) => {
      listenersRef.current.add(listener);
      listener(currentOcclusionRef.current);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
    []
  );

  const registerNativeSurfaceHost = useCallback(() => {
    surfaceHostCountRef.current += 1;
    return () => {
      surfaceHostCountRef.current = Math.max(0, surfaceHostCountRef.current - 1);
      if (surfaceHostCountRef.current === 0) {
        ackedEpochRef.current = overlayEpochRef.current;
        flushOverlayWaiters();
      }
    };
  }, [flushOverlayWaiters]);

  const ackOverlayReady = useCallback(() => {
    ackedEpochRef.current = overlayEpochRef.current;
    flushOverlayWaiters();
  }, [flushOverlayWaiters]);

  const isOverlayReady = useCallback(
    () =>
      surfaceHostCountRef.current === 0 ||
      ackedEpochRef.current === overlayEpochRef.current,
    []
  );

  const waitForOverlayReady = useCallback(() => {
    if (isOverlayReady()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, OVERLAY_READY_TIMEOUT_MS);
      overlayWaitersRef.current.push(finish);
    });
  }, [isOverlayReady]);

  useLayoutEffect(() => {
    nativeSurfaceOccludedRef.current = nativeSurfaceOccluded;
    publishOcclusion();
  }, [nativeSurfaceOccluded, publishOcclusion]);

  const value = useMemo(
    () => ({
      setTabCreationMenuOpen,
      setHtmlOverlayOpen,
      setHtmlOverlayRect,
      subscribeNativeSurfaceOcclusion,
      registerNativeSurfaceHost,
      ackOverlayReady,
      waitForOverlayReady,
      isOverlayReady,
    }),
    [
      setHtmlOverlayOpen,
      setHtmlOverlayRect,
      setTabCreationMenuOpen,
      subscribeNativeSurfaceOcclusion,
      registerNativeSurfaceHost,
      ackOverlayReady,
      waitForOverlayReady,
      isOverlayReady,
    ]
  );

  return (
    <WorkspaceOverlayContext.Provider value={value}>
      {children}
    </WorkspaceOverlayContext.Provider>
  );
}

export function useWorkspaceOverlay(): WorkspaceOverlayContextValue {
  return useContext(WorkspaceOverlayContext);
}

/** Publish this overlay's rectangle so a native page can step aside where they overlap. */
export function NativeSurfaceOcclusionHold() {
  const { setHtmlOverlayRect } = useWorkspaceOverlay();
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const overlay = anchorRef.current?.parentElement;
    if (!overlay) return;

    const publish = () => {
      const rect = overlay.getBoundingClientRect();
      // Opening/closing animations can report an empty box for a frame.
      // Clearing the rect would flash the native page back in.
      if (rect.width < 1 || rect.height < 1) return;
      setHtmlOverlayRect(id, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    publish();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(publish);
    observer?.observe(overlay);
    window.addEventListener('scroll', publish, true);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', publish, true);
      window.removeEventListener('resize', publish);
      setHtmlOverlayRect(id, null);
    };
  }, [id, setHtmlOverlayRect]);

  return (
    <span
      ref={anchorRef}
      aria-hidden="true"
      data-native-surface-occlusion=""
      style={{
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    />
  );
}
