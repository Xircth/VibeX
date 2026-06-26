import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { ExecutorProfileId } from 'shared/types';

/**
 * Bridges the composer's *effective* executor profile (the model/variant/reasoning
 * selection shown in the message input box) to sibling surfaces that re-send turns
 * — chiefly the conversation timeline's reset-to-here retry.
 *
 * Without this bridge the retry handler can only see `session.executor` (a bare
 * agent key with no variant/model), so it falls back to the agent's DEFAULT
 * profile and silently overrides the user's choice (e.g. Codex resends land on
 * `gpt-5.3-codex` even after the user picked GPT-5.5). Publishing the composer's
 * selection keeps the create form, the input box, and every actual turn (initial,
 * follow-up, and resend) sourced from the same profile.
 *
 * Ref-backed on purpose: the value is read lazily inside the retry callback, so a
 * model switch must NOT re-render the (heavy, virtualized) conversation list.
 */
type ActiveExecutorProfileContextValue = {
  /** Latest profile selected in the composer, or null when none is published. */
  getActiveExecutorProfile: () => ExecutorProfileId | null;
  /** Publish the composer's effective profile for sibling surfaces to read. */
  setActiveExecutorProfile: (profile: ExecutorProfileId | null) => void;
};

const ActiveExecutorProfileContext =
  createContext<ActiveExecutorProfileContextValue | null>(null);

export function ActiveExecutorProfileProvider({
  children,
}: {
  children: ReactNode;
}) {
  const profileRef = useRef<ExecutorProfileId | null>(null);
  const value = useMemo<ActiveExecutorProfileContextValue>(
    () => ({
      getActiveExecutorProfile: () => profileRef.current,
      setActiveExecutorProfile: (profile) => {
        profileRef.current = profile;
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

const NOOP_VALUE: ActiveExecutorProfileContextValue = {
  getActiveExecutorProfile: () => null,
  setActiveExecutorProfile: () => {},
};

/**
 * Non-throwing accessor. Surfaces rendered outside a provider (e.g. the read-only
 * logs panel, which has no composer to source a selection from) safely get a
 * no-op, and the retry handler keeps its `session.executor` fallback.
 */
export function useActiveExecutorProfile(): ActiveExecutorProfileContextValue {
  return useContext(ActiveExecutorProfileContext) ?? NOOP_VALUE;
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
