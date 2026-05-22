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

interface EntriesContextType {
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
  setTokenUsageInfo: (info: TokenUsageInfo | null) => void;
  reset: () => void;
  tokenUsageInfo: TokenUsageInfo | null;
}

type EntriesRuntimeValue = {
  entries: PatchTypeWithKey[];
  tokenUsageInfo: TokenUsageInfo | null;
};

const EMPTY_RUNTIME_VALUE: EntriesRuntimeValue = {
  entries: [],
  tokenUsageInfo: null,
};

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
      reset,
      tokenUsageInfo: localValue.tokenUsageInfo,
    }),
    [localValue, reset, setEntries, setTokenUsageInfo]
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
