import {
  useCallback,
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

type NativeSurfaceOcclusionListener = (occluded: boolean) => void;

interface WorkspaceOverlayContextValue {
  setTabCreationMenuOpen: (open: boolean) => void;
  /** Hide native CEF surfaces while an HTML overlay (select, menu) is open. */
  setHtmlOverlayOpen: (open: boolean) => void;
  subscribeNativeSurfaceOcclusion: (
    listener: NativeSurfaceOcclusionListener
  ) => () => void;
}

export const WorkspaceOverlayContext =
  createContext<WorkspaceOverlayContextValue>({
    setTabCreationMenuOpen: () => {},
    setHtmlOverlayOpen: () => {},
    subscribeNativeSurfaceOcclusion: (listener) => {
      listener(false);
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
  const currentOcclusionRef = useRef(nativeSurfaceOccluded);
  const listenersRef = useRef(new Set<NativeSurfaceOcclusionListener>());

  const publishOcclusion = useCallback(() => {
    const nextOcclusion =
      nativeSurfaceOccludedRef.current ||
      tabCreationMenuOpenRef.current ||
      htmlOverlayCountRef.current > 0;
    if (currentOcclusionRef.current === nextOcclusion) return;

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
      subscribeNativeSurfaceOcclusion,
    }),
    [
      setHtmlOverlayOpen,
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
