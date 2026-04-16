import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  ReactNode,
} from 'react';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';
import { TokenUsageInfo } from 'shared/types';
import { useSessionConversationStore } from '@/stores/useSessionConversationStore';

interface EntriesContextType {
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
  setTokenUsageInfo: (info: TokenUsageInfo | null) => void;
  reset: () => void;
  tokenUsageInfo: TokenUsageInfo | null;
}

const EntriesContext = createContext<EntriesContextType | null>(null);

type EntriesCacheValue = {
  entries: PatchTypeWithKey[];
  tokenUsageInfo: TokenUsageInfo | null;
};

function getCachedEntriesValue(cacheKey?: string): EntriesCacheValue {
  if (!cacheKey) {
    return {
      entries: [],
      tokenUsageInfo: null,
    };
  }

  const snapshot = useSessionConversationStore.getState().getSnapshot(cacheKey);
  return snapshot
    ? {
        entries: snapshot.entries,
        tokenUsageInfo: snapshot.tokenUsageInfo,
      }
    : {
        entries: [],
        tokenUsageInfo: null,
      };
}

interface EntriesProviderProps {
  children: ReactNode;
  cacheKey?: string;
}

export const EntriesProvider = ({
  children,
  cacheKey,
}: EntriesProviderProps) => {
  const cachedValue = getCachedEntriesValue(cacheKey);
  const [entries, setEntriesState] = useState<PatchTypeWithKey[]>(
    cachedValue.entries
  );
  const [tokenUsageInfo, setTokenUsageInfo] = useState<TokenUsageInfo | null>(
    cachedValue.tokenUsageInfo
  );
  const entriesRef = useRef(entries);
  const tokenUsageInfoRef = useRef(tokenUsageInfo);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    tokenUsageInfoRef.current = tokenUsageInfo;
  }, [tokenUsageInfo]);

  useEffect(() => {
    const nextValue = getCachedEntriesValue(cacheKey);
    entriesRef.current = nextValue.entries;
    tokenUsageInfoRef.current = nextValue.tokenUsageInfo;
    setEntriesState(nextValue.entries);
    setTokenUsageInfo(nextValue.tokenUsageInfo);
  }, [cacheKey]);

  const updateCache = useCallback(
    (
      nextEntries: PatchTypeWithKey[] = entriesRef.current,
      nextTokenUsageInfo: TokenUsageInfo | null = tokenUsageInfoRef.current
    ) => {
      if (!cacheKey) return;

      useSessionConversationStore.getState().saveSnapshot(cacheKey, {
        entries: nextEntries,
        tokenUsageInfo: nextTokenUsageInfo,
      });
    },
    [cacheKey]
  );

  const setEntries = useCallback(
    (newEntries: PatchTypeWithKey[]) => {
      const cachedValue = cacheKey
        ? useSessionConversationStore.getState().getSnapshot(cacheKey)
        : undefined;
      const hasPersistedEntries = (cachedValue?.entries.length ?? 0) > 0;
      const shouldIgnoreEmptyReplacement =
        newEntries.length === 0 &&
        hasPersistedEntries &&
        entriesRef.current.length > 0;

      if (shouldIgnoreEmptyReplacement) {
        return;
      }

      entriesRef.current = newEntries;
      setEntriesState(newEntries);
      updateCache(newEntries, tokenUsageInfoRef.current);
    },
    [cacheKey, updateCache]
  );

  const setTokenUsageInfoCallback = useCallback(
    (info: TokenUsageInfo | null) => {
      tokenUsageInfoRef.current = info;
      setTokenUsageInfo(info);
      updateCache(entriesRef.current, info);
    },
    [updateCache]
  );

  const reset = useCallback(() => {
    entriesRef.current = [];
    tokenUsageInfoRef.current = null;
    setEntriesState([]);
    setTokenUsageInfo(null);
    if (cacheKey) {
      useSessionConversationStore.getState().clearSnapshot(cacheKey);
    }
    updateCache([], null);
  }, [cacheKey, updateCache]);

  const value = useMemo(
    () => ({
      entries,
      setEntries,
      setTokenUsageInfo: setTokenUsageInfoCallback,
      reset,
      tokenUsageInfo,
    }),
    [entries, setEntries, setTokenUsageInfoCallback, reset, tokenUsageInfo]
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
