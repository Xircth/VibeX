import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import {
  useCollaborationSpaceRuntime,
  type CollaborationSpaceRuntime,
} from './CollaborationSpaceRuntime';
import {
  CollaborationSpaceStoreContext,
  useHasCollaborationSpaceProvider,
  useOptionalCollaborationSpaceStore,
  type CollaborationSpaceListener,
  type CollaborationSpaceStore,
} from './SpaceStoreContext';

export {
  useHasCollaborationSpaceProvider,
  useOptionalCollaborationSpaceStore,
  type CollaborationSpaceListener,
  type CollaborationSpaceStore,
};

import type { SpaceInitialTarget } from './types';
import {
  CollaborationCanvasCreateOverlay,
  CollaborationStageCreateOverlay,
} from '../CollaborationCreateOverlay';

function CollaborationSpaceRuntimeBridge({
  workspaceId,
  initialTarget,
  valueRef,
  listenersRef,
}: {
  workspaceId: string | null;
  initialTarget?: SpaceInitialTarget | null;
  valueRef: MutableRefObject<CollaborationSpaceRuntime | null>;
  listenersRef: MutableRefObject<Set<CollaborationSpaceListener>>;
}) {
  const value = useCollaborationSpaceRuntime(workspaceId, { initialTarget });
  valueRef.current = value;

  useLayoutEffect(() => {
    for (const listener of listenersRef.current) {
      listener();
    }
  });

  return null;
}

export function OptionalCollaborationSpaceProvider({
  enabled,
  workspaceId,
  initialTarget,
  children,
}: {
  enabled: boolean;
  workspaceId: string | null;
  initialTarget?: SpaceInitialTarget | null;
  children: ReactNode;
}) {
  const valueRef = useRef<CollaborationSpaceRuntime | null>(null);
  if (!enabled) {
    valueRef.current = null;
  }
  const listenersRef = useRef<Set<CollaborationSpaceListener>>(new Set());

  const store = useMemo<CollaborationSpaceStore>(
    () => ({
      getSnapshot: () => {
        if (!valueRef.current) {
          throw new Error(
            'CollaborationSpaceStore read while CollaborationSpaceProvider is disabled'
          );
        }
        return valueRef.current;
      },
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    []
  );

  return (
    <CollaborationSpaceStoreContext.Provider value={enabled ? store : null}>
      {enabled ? (
        <CollaborationSpaceRuntimeBridge
          workspaceId={workspaceId}
          initialTarget={initialTarget}
          valueRef={valueRef}
          listenersRef={listenersRef}
        />
      ) : null}
      {children}
      {enabled ? <CollaborationCanvasCreateOverlay /> : null}
      {enabled ? <CollaborationStageCreateOverlay /> : null}
    </CollaborationSpaceStoreContext.Provider>
  );
}

export function CollaborationSpaceProvider({
  workspaceId,
  initialTarget,
  children,
}: {
  workspaceId: string | null;
  initialTarget?: SpaceInitialTarget | null;
  children: ReactNode;
}) {
  return (
    <OptionalCollaborationSpaceProvider
      enabled
      workspaceId={workspaceId}
      initialTarget={initialTarget}
    >
      {children}
    </OptionalCollaborationSpaceProvider>
  );
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
