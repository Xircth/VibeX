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
import type { OverlayRect } from '@/features/browser/nativeSurfaceOverlay';

export type { OverlayRect };

export interface NativeSurfaceOcclusion {
  /** Hide the entire native surface (tab context menu, explicit holds). */
  hide: boolean;
  /** Popover rectangles that should hide CEF so HTML can stack above the page. */
  rects: OverlayRect[];
}

type NativeSurfaceOcclusionListener = (
  occlusion: NativeSurfaceOcclusion
) => void;

interface WorkspaceOverlayContextValue {
  setTabCreationMenuOpen: (open: boolean) => void;
  /** Hide native CEF surfaces while an HTML overlay (select, menu) is open. */
  setHtmlOverlayOpen: (open: boolean) => void;
  setHtmlOverlayRect: (id: string, rect: OverlayRect | null) => void;
  subscribeNativeSurfaceOcclusion: (
    listener: NativeSurfaceOcclusionListener
  ) => () => void;
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

export const WorkspaceOverlayContext =
  createContext<WorkspaceOverlayContextValue>({
    setTabCreationMenuOpen: () => {},
    setHtmlOverlayOpen: () => {},
    setHtmlOverlayRect: () => {},
    subscribeNativeSurfaceOcclusion: (listener) => {
      listener(EMPTY_OCCLUSION);
      return () => {};
    },
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
    for (const listener of listenersRef.current) {
      listener(nextOcclusion);
    }
  }, []);

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
    }),
    [
      setHtmlOverlayOpen,
      setHtmlOverlayRect,
      setTabCreationMenuOpen,
      subscribeNativeSurfaceOcclusion,
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

/** Hide native CEF under this overlay so the popover can paint above the page. */
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
