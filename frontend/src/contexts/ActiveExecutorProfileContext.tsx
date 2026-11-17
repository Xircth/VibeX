import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AgentKind, ExecutorProfileId } from 'shared/types';

export type PendingAgentHandoff = {
  sessionId: string;
  fromAgent: AgentKind | string;
  toAgent: AgentKind | string;
  fromModelLabel: string | null;
  toModelLabel: string | null;
  handoffTokens?: number | null;
  continuationPolicy: 'portable' | 'fresh';
};

function isSamePendingHandoff(
  left: PendingAgentHandoff | null,
  right: PendingAgentHandoff | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.sessionId === right.sessionId &&
    left.fromAgent === right.fromAgent &&
    left.toAgent === right.toAgent &&
    left.fromModelLabel === right.fromModelLabel &&
    left.toModelLabel === right.toModelLabel &&
    (left.handoffTokens ?? null) === (right.handoffTokens ?? null) &&
    left.continuationPolicy === right.continuationPolicy
  );
}

/**
 * Bridges the composer's *effective* executor profile (the model/variant/reasoning
 * selection shown in the message input box) to sibling surfaces that re-send turns
 * — chiefly the conversation timeline's reset-to-here retry — plus a lightweight
 * external-store channel for pending cross-agent handoff previews at the tail of
 * the message stream.
 *
 * Ref-backed on purpose: neither a model switch nor an agent switch re-renders the
 * (heavy, virtualized) conversation list; only leaf subscribers opt in via
 * `usePendingAgentHandoff`.
 */
type ActiveExecutorProfileContextValue = {
  /** Latest profile selected in the composer, or null when none is published. */
  getActiveExecutorProfile: () => ExecutorProfileId | null;
  /** Publish the composer's effective profile for sibling surfaces to read. */
  setActiveExecutorProfile: (profile: ExecutorProfileId | null) => void;
  /** Read the current pending cross-agent handoff state, if any. */
  getPendingAgentHandoff: () => PendingAgentHandoff | null;
  /** Publish or clear a pending cross-agent handoff preview. */
  setPendingAgentHandoff: (handoff: PendingAgentHandoff | null) => void;
  /** Subscribe to pending cross-agent handoff changes. */
  subscribePendingAgentHandoff: (listener: () => void) => () => void;
};

const ActiveExecutorProfileContext =
  createContext<ActiveExecutorProfileContextValue | null>(null);

export function ActiveExecutorProfileProvider({
  children,
}: {
  children: ReactNode;
}) {
  const profileRef = useRef<ExecutorProfileId | null>(null);
  const handoffRef = useRef<PendingAgentHandoff | null>(null);
  const handoffListenersRef = useRef(new Set<() => void>());
  const value = useMemo<ActiveExecutorProfileContextValue>(
    () => ({
      getActiveExecutorProfile: () => profileRef.current,
      setActiveExecutorProfile: (profile) => {
        profileRef.current = profile;
      },
      getPendingAgentHandoff: () => handoffRef.current,
      setPendingAgentHandoff: (handoff) => {
        if (isSamePendingHandoff(handoffRef.current, handoff)) {
          return;
        }
        handoffRef.current = handoff;
        for (const listener of handoffListenersRef.current) {
          listener();
        }
      },
      subscribePendingAgentHandoff: (listener) => {
        handoffListenersRef.current.add(listener);
        return () => {
          handoffListenersRef.current.delete(listener);
        };
      },
    }),
    []
  );

  return (
    <ActiveExecutorProfileContext.Provider value={value}>
      {children}
    </ActiveExecutorProfileContext.Provider>
  );
}

const NOOP_SUBSCRIBE = () => () => {};

const NOOP_VALUE: ActiveExecutorProfileContextValue = {
  getActiveExecutorProfile: () => null,
  setActiveExecutorProfile: () => {},
  getPendingAgentHandoff: () => null,
  setPendingAgentHandoff: () => {},
  subscribePendingAgentHandoff: NOOP_SUBSCRIBE,
};

/**
 * Non-throwing accessor. Surfaces rendered outside a provider (e.g. the read-only
 * logs panel, which has no composer to source a selection from) safely get a
 * no-op, and the retry handler keeps its `session.executor` fallback.
 */
export function useActiveExecutorProfile(): ActiveExecutorProfileContextValue {
  return useContext(ActiveExecutorProfileContext) ?? NOOP_VALUE;
}

export function usePendingAgentHandoff(
  sessionId: string | null | undefined
): PendingAgentHandoff | null {
  const { getPendingAgentHandoff, subscribePendingAgentHandoff } =
    useActiveExecutorProfile();
  const getSnapshot = useCallback(() => {
    if (!sessionId) return null;
    const current = getPendingAgentHandoff();
    return current?.sessionId === sessionId ? current : null;
  }, [getPendingAgentHandoff, sessionId]);

  return useSyncExternalStore(
    subscribePendingAgentHandoff,
    getSnapshot,
    getSnapshot
  );
}

/**
 * Resolve the profile a reset-to-here resend should use. Prefer the composer's
 * live selection so the resend honors the user's model/variant exactly; fall back
 * to the bare session agent only when no matching selection is published (no
 * composer mounted, or the composer switched to a different agent than this
 * session's). Keeping the agent pinned to the session avoids re-sending into a
 * session bound to a different agent.
 */
export function resolveResendExecutorProfile(
  activeProfile: ExecutorProfileId | null,
  sessionExecutor: ExecutorProfileId['executor']
): ExecutorProfileId {
  if (activeProfile && activeProfile.executor === sessionExecutor) {
    return activeProfile;
  }
  return { executor: sessionExecutor, variant: null };
}
