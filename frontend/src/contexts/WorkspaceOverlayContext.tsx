import {
  useCallback,
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import {
  collectFloatingLayers,
  mutationTouchesFloatingLayer,
  uniqueOverlayRects,
  type FloatingLayerOcclusion,
} from '@/lib/floatingLayer';
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
  /** Kanban / tab chrome that must cover every native page. */
  setChromeOccluded: (occluded: boolean) => void;
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

/** Long enough for a freeze-frame capture plus one paint before the menu
 *  reveals over a still-visible native HWND. */
const OVERLAY_READY_TIMEOUT_MS = 500;

export const WorkspaceOverlayContext =
  createContext<WorkspaceOverlayContextValue>({
    setTabCreationMenuOpen: () => {},
    setHtmlOverlayOpen: () => {},
    setHtmlOverlayRect: () => {},
    setChromeOccluded: () => {},
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
  const observedOcclusionRef = useRef<FloatingLayerOcclusion>(EMPTY_OCCLUSION);
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
    const observed = observedOcclusionRef.current;
    const nextOcclusion: NativeSurfaceOcclusion = {
      hide:
        nativeSurfaceOccludedRef.current ||
        tabCreationMenuOpenRef.current ||
        htmlOverlayCountRef.current > 0 ||
        observed.hide,
      rects: uniqueOverlayRects([
        ...overlayRectsRef.current.values(),
        ...observed.rects,
      ]),
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

  const setChromeOccluded = useCallback(
    (occluded: boolean) => {
      nativeSurfaceOccludedRef.current = occluded;
      publishOcclusion();
    },
    [publishOcclusion]
  );

  const setObservedOcclusion = useCallback(
    (occlusion: FloatingLayerOcclusion) => {
      const previous = observedOcclusionRef.current;
      if (
        previous.hide === occlusion.hide &&
        occlusionEqual(
          { hide: false, rects: previous.rects },
          { hide: false, rects: occlusion.rects }
        )
      ) {
        return;
      }
      observedOcclusionRef.current = occlusion;
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
      setChromeOccluded,
      subscribeNativeSurfaceOcclusion,
      registerNativeSurfaceHost,
      ackOverlayReady,
      waitForOverlayReady,
      isOverlayReady,
    }),
    [
      setHtmlOverlayOpen,
      setHtmlOverlayRect,
      setChromeOccluded,
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
      <FloatingLayerObserver onChange={setObservedOcclusion} />
      {children}
    </WorkspaceOverlayContext.Provider>
  );
}

function FloatingLayerObserver({
  onChange,
}: {
  onChange: (occlusion: FloatingLayerOcclusion) => void;
}) {
  const portal = usePortalContainer();

  useLayoutEffect(() => {
    const overlayRoot =
      (typeof document !== 'undefined'
        ? document.querySelector('[data-overlay-root]')
        : null) ??
      portal ??
      (typeof document !== 'undefined' ? document.body : null);
    if (!overlayRoot) return undefined;

    const publish = () => onChange(collectFloatingLayers(overlayRoot));
    publish();
    const mutation =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            if (!mutationTouchesFloatingLayer(records)) return;
            publish();
          });
    mutation?.observe(overlayRoot, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', publish);
    window.addEventListener('scroll', publish, true);
    return () => {
      mutation?.disconnect();
      window.removeEventListener('resize', publish);
      window.removeEventListener('scroll', publish, true);
      onChange({ hide: false, rects: [] });
    };
  }, [onChange, portal]);

  return null;
}

/** Delay painting a floating layer until native pages have frozen and stepped aside. */
export function useRevealAfterOverlayReady(): boolean {
  const { isOverlayReady, waitForOverlayReady } = useWorkspaceOverlay();
  const [revealed, setRevealed] = useState(() => isOverlayReady());
  useLayoutEffect(() => {
    if (isOverlayReady()) {
      setRevealed(true);
      return undefined;
    }
    let cancelled = false;
    void waitForOverlayReady().then(() => {
      if (!cancelled) setRevealed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isOverlayReady, waitForOverlayReady]);
  return revealed;
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
