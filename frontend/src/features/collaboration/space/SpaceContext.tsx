import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  useCollaborationSpaceRuntime,
  type CollaborationSpaceRuntime,
} from './CollaborationSpaceRuntime';

type CollaborationSpaceListener = () => void;

interface CollaborationSpaceStore {
  getSnapshot: () => CollaborationSpaceRuntime;
  subscribe: (listener: CollaborationSpaceListener) => () => void;
}

const CollaborationSpaceStoreContext =
  createContext<CollaborationSpaceStore | null>(null);

export function CollaborationSpaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null;
  children: ReactNode;
}) {
  const value = useCollaborationSpaceRuntime(workspaceId);
  const valueRef = useRef<CollaborationSpaceRuntime>(value);
  valueRef.current = value;
  const listenersRef = useRef<Set<CollaborationSpaceListener>>(new Set());

  const store = useMemo<CollaborationSpaceStore>(
    () => ({
      getSnapshot: () => valueRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    []
  );

  useLayoutEffect(() => {
    for (const listener of listenersRef.current) {
      listener();
    }
  });

  return (
    <CollaborationSpaceStoreContext.Provider value={store}>
      {children}
    </CollaborationSpaceStoreContext.Provider>
  );
}

export function useHasCollaborationSpaceProvider(): boolean {
  return useContext(CollaborationSpaceStoreContext) !== null;
}

export function useOptionalCollaborationSpaceStore(): CollaborationSpaceStore | null {
  return useContext(CollaborationSpaceStoreContext);
}

function useCollaborationSpaceStore(): CollaborationSpaceStore {
  const store = useContext(CollaborationSpaceStoreContext);
  if (!store) {
    throw new Error(
      'useCollaborationSpace must be used within CollaborationSpaceProvider'
    );
  }
  return store;
}

export function useCollaborationSpace(): CollaborationSpaceRuntime {
  const store = useCollaborationSpaceStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}

const RENDER_CLOSURE_KEYS = new Set<keyof CollaborationSpaceRuntime>([
  'renderChatEntry',
  'renderChatMeta',
  'renderDirectChatRow',
  'renderMemberRow',
  'renderMessageAreaOverlay',
  'renderSectionEntry',
  'renderSpaceGroup',
  'renderSupervisorSlot',
]);

export function useCollaborationSpacePick<
  K extends keyof CollaborationSpaceRuntime,
>(keys: readonly K[]): Pick<CollaborationSpaceRuntime, K> {
  const store = useCollaborationSpaceStore();
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const cacheRef = useRef<Pick<CollaborationSpaceRuntime, K> | null>(null);

  const getSnapshot = () => {
    const runtime = store.getSnapshot();
    const currentKeys = keysRef.current;
    const prev = cacheRef.current;
    if (prev !== null) {
      let unchanged = true;
      for (let i = 0; i < currentKeys.length; i += 1) {
        const key = currentKeys[i]!;
        if (RENDER_CLOSURE_KEYS.has(key)) {
          continue;
        }
        if (!Object.is(prev[key], runtime[key])) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        return prev;
      }
    }
    const next = {} as Pick<CollaborationSpaceRuntime, K>;
    for (let i = 0; i < currentKeys.length; i += 1) {
      const key = currentKeys[i]!;
      const val = runtime[key];
      if (RENDER_CLOSURE_KEYS.has(key) && typeof val === 'function') {
        next[key] = ((...args: unknown[]) =>
          (val as (...a: unknown[]) => unknown)(
            ...args
          )) as CollaborationSpaceRuntime[K];
      } else {
        next[key] = val;
      }
    }
    cacheRef.current = next;
    return next;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
