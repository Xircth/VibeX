import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';
import type { TokenUsageInfo } from 'shared/types';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';

const EMPTY_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};

interface EntriesContextType {
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
  setTokenUsageInfo: (info: TokenUsageInfo | null) => void;
  setSessionModes: (modes: ConversationSessionModesState) => void;
  reset: () => void;
  tokenUsageInfo: TokenUsageInfo | null;
  sessionModes: ConversationSessionModesState;
}

type EntriesRuntimeValue = {
  entries: PatchTypeWithKey[];
  tokenUsageInfo: TokenUsageInfo | null;
  sessionModes: ConversationSessionModesState;
};

const EMPTY_RUNTIME_VALUE: EntriesRuntimeValue = {
  entries: [],
  tokenUsageInfo: null,
  sessionModes: EMPTY_SESSION_MODES,
};

function sessionModesEqual(
  a: ConversationSessionModesState,
  b: ConversationSessionModesState
): boolean {
  if (a === b) return true;
  if (a.current !== b.current || a.modes.length !== b.modes.length) return false;
  return a.modes.every((mode, index) => {
    const other = b.modes[index];
    return (
      mode.id === other.id &&
      mode.label === other.label &&
      mode.description === other.description
    );
  });
}

function tokenUsageEqual(
  a: TokenUsageInfo | null,
  b: TokenUsageInfo | null
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.total_tokens === b.total_tokens &&
    a.model_context_window === b.model_context_window
  );
}

const entriesRuntimeByKey = new Map<string, EntriesRuntimeValue>();
const listenersByKey = new Map<string, Set<() => void>>();

const EntriesContext = createContext<EntriesContextType | null>(null);

function getRuntimeValue(key: string): EntriesRuntimeValue {
  return entriesRuntimeByKey.get(key) ?? EMPTY_RUNTIME_VALUE;
}

function writeRuntimeValue(key: string, value: EntriesRuntimeValue) {
  entriesRuntimeByKey.set(key, value);
  listenersByKey.get(key)?.forEach((listener) => listener());
}

function subscribeRuntimeValue(key: string, listener: () => void) {
  const listeners = listenersByKey.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByKey.set(key, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByKey.delete(key);
    }
  };
}

export function clearEntriesRuntimeForTests() {
  entriesRuntimeByKey.clear();
  listenersByKey.clear();
}

interface EntriesProviderProps {
  children: ReactNode;
  runtimeKey?: string;
}

export const EntriesProvider = ({
  children,
  runtimeKey,
}: EntriesProviderProps) => {
  const [localValue, setLocalValue] = useState<EntriesRuntimeValue>(() =>
    runtimeKey ? getRuntimeValue(runtimeKey) : EMPTY_RUNTIME_VALUE
  );
  const localValueRef = useRef(localValue);

  useEffect(() => {
    localValueRef.current = localValue;
  }, [localValue]);

  useEffect(() => {
    if (!runtimeKey) {
      const nextValue = EMPTY_RUNTIME_VALUE;
      localValueRef.current = nextValue;
      setLocalValue(nextValue);
      return;
    }

    const sync = () => {
      const nextValue = getRuntimeValue(runtimeKey);
      localValueRef.current = nextValue;
      setLocalValue(nextValue);
    };

    sync();
    return subscribeRuntimeValue(runtimeKey, sync);
  }, [runtimeKey]);

  const setEntries = useCallback(
    (newEntries: PatchTypeWithKey[]) => {
      const nextValue = {
        ...localValueRef.current,
        entries: newEntries,
      };
      localValueRef.current = nextValue;

      if (runtimeKey) {
        writeRuntimeValue(runtimeKey, nextValue);
        return;
      }

      setLocalValue(nextValue);
    },
    [runtimeKey]
  );

  const setTokenUsageInfo = useCallback(
    (info: TokenUsageInfo | null) => {
      // Skip no-op writes. The live timeline recomputes a fresh TokenUsageInfo
      // object on every streaming delta; without this guard each identical write
      // notifies subscribers → re-render → effect re-fires → an unbounded
      // setState loop ("Maximum update depth exceeded").
      if (tokenUsageEqual(localValueRef.current.tokenUsageInfo, info)) {
        return;
      }
      const nextValue = {
        ...localValueRef.current,
        tokenUsageInfo: info,
      };
      localValueRef.current = nextValue;

      if (runtimeKey) {
        writeRuntimeValue(runtimeKey, nextValue);
        return;
      }

      setLocalValue(nextValue);
    },
    [runtimeKey]
  );

  const setSessionModes = useCallback(
    (modes: ConversationSessionModesState) => {
      // Same no-op guard as token usage: the live timeline recomputes a fresh
      // modes object on each event; skip identical writes to avoid render loops.
      if (sessionModesEqual(localValueRef.current.sessionModes, modes)) {
        return;
      }
      const nextValue = {
        ...localValueRef.current,
        sessionModes: modes,
      };
      localValueRef.current = nextValue;

      if (runtimeKey) {
        writeRuntimeValue(runtimeKey, nextValue);
        return;
      }

      setLocalValue(nextValue);
    },
    [runtimeKey]
  );

  const reset = useCallback(() => {
    localValueRef.current = EMPTY_RUNTIME_VALUE;

    if (runtimeKey) {
      writeRuntimeValue(runtimeKey, EMPTY_RUNTIME_VALUE);
      return;
    }

    setLocalValue(EMPTY_RUNTIME_VALUE);
  }, [runtimeKey]);

  const value = useMemo(
    () => ({
      entries: localValue.entries,
      setEntries,
      setTokenUsageInfo,
      setSessionModes,
      reset,
      tokenUsageInfo: localValue.tokenUsageInfo,
      sessionModes: localValue.sessionModes,
    }),
    [localValue, reset, setEntries, setTokenUsageInfo, setSessionModes]
  );

  return (
    <EntriesContext.Provider value={value}>{children}</EntriesContext.Provider>
  );
};

export const useEntries = (): EntriesContextType => {
  const context = useContext(EntriesContext);
  if (!context) {
    throw new Error('useEntries must be used within an EntriesProvider');
  }
  return context;
};

export const useTokenUsage = () => {
  const context = useContext(EntriesContext);
  if (!context) {
    throw new Error('useTokenUsage must be used within an EntriesProvider');
  }
  return context.tokenUsageInfo;
};

/** Non-throwing accessor for callers that may render outside an EntriesProvider. */
export const useOptionalEntries = (): EntriesContextType | null =>
  useContext(EntriesContext);
