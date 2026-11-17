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
import type { PatchTypeWithKey } from '@/hooks/conversationEntries';
import type {
  AgentSessionConfigOption,
  DeliveryChannel,
  PlanEntry,
  TokenUsageInfo,
} from 'shared/types';
import type { ConversationSessionModesState } from '@/features/conversation/conversationStore';
import type { ComposerSteeringTarget } from '@/components/tasks/follow-up/sessionComposerSteering';

const EMPTY_SESSION_MODES: ConversationSessionModesState = {
  current: null,
  modes: [],
};

const EMPTY_SESSION_CONFIG_OPTIONS: AgentSessionConfigOption[] = [];
const EMPTY_CONVERSATION_PLAN_ENTRIES: PlanEntry[] = [];
const EMPTY_USER_MESSAGE_HISTORY: string[] = [];

interface EntriesContextType {
  entries: PatchTypeWithKey[];
  setEntries: (entries: PatchTypeWithKey[]) => void;
  setTokenUsageInfo: (info: TokenUsageInfo | null) => void;
  setSessionModes: (modes: ConversationSessionModesState) => void;
  setSessionConfigOptions: (options: AgentSessionConfigOption[]) => void;
  setConversationPlanEntries: (entries: PlanEntry[]) => void;
  setConversationTurnInFlight: (inFlight: boolean) => void;
  setConversationSteeringTurnId: (turnId: string | null) => void;
  setConversationSteeringTarget: (
    target: ComposerSteeringTarget | null
  ) => void;
  setConversationDeliveryChannel: (channel: DeliveryChannel) => void;
  setUserMessageHistory: (messages: string[]) => void;
  reset: () => void;
  tokenUsageInfo: TokenUsageInfo | null;
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
  conversationPlanEntries: PlanEntry[];
  conversationTurnInFlight: boolean;
  conversationSteeringTurnId: string | null;
  conversationSteeringTarget: ComposerSteeringTarget | null;
  conversationDeliveryChannel: DeliveryChannel;
  userMessageHistory: string[];
}

type EntriesRuntimeValue = {
  entries: PatchTypeWithKey[];
  tokenUsageInfo: TokenUsageInfo | null;
  sessionModes: ConversationSessionModesState;
  sessionConfigOptions: AgentSessionConfigOption[];
  conversationPlanEntries: PlanEntry[];
  conversationTurnInFlight: boolean;
  conversationSteeringTurnId: string | null;
  conversationSteeringTarget: ComposerSteeringTarget | null;
  conversationDeliveryChannel: DeliveryChannel;
  userMessageHistory: string[];
};

const EMPTY_RUNTIME_VALUE: EntriesRuntimeValue = {
  entries: [],
  tokenUsageInfo: null,
  sessionModes: EMPTY_SESSION_MODES,
  sessionConfigOptions: EMPTY_SESSION_CONFIG_OPTIONS,
  conversationPlanEntries: EMPTY_CONVERSATION_PLAN_ENTRIES,
  conversationTurnInFlight: false,
  conversationSteeringTurnId: null,
  conversationSteeringTarget: null,
  conversationDeliveryChannel: 'none',
  userMessageHistory: EMPTY_USER_MESSAGE_HISTORY,
};

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function planEntriesEqual(a: PlanEntry[], b: PlanEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      entry.content === other?.content &&
      entry.status === other?.status &&
      (entry.priority ?? null) === (other?.priority ?? null)
    );
  });
}

function sessionModesEqual(
  a: ConversationSessionModesState,
  b: ConversationSessionModesState
): boolean {
  if (a === b) return true;
  if (a.current !== b.current || a.modes.length !== b.modes.length)
    return false;
  return a.modes.every((mode, index) => {
    const other = b.modes[index];
    return (
      mode.id === other?.id &&
      mode.label === other?.label &&
      (mode.description ?? null) === (other?.description ?? null)
    );
  });
}

function sessionConfigOptionsEqual(
  a: AgentSessionConfigOption[],
  b: AgentSessionConfigOption[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  // Options carry JSON values (current value + choices); structural compare via
  // stable serialization is proportionate to their tiny size.
  return a.every(
    (option, index) => JSON.stringify(option) === JSON.stringify(b[index])
  );
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

type EntriesActionsContextType = Pick<
  EntriesContextType,
  | 'setEntries'
  | 'setTokenUsageInfo'
  | 'setSessionModes'
  | 'setSessionConfigOptions'
  | 'setConversationPlanEntries'
  | 'setConversationTurnInFlight'
  | 'setConversationSteeringTurnId'
  | 'setConversationSteeringTarget'
  | 'setConversationDeliveryChannel'
  | 'setUserMessageHistory'
  | 'reset'
>;

const MAX_RUNTIME_CACHE_ENTRIES = 24;
const entriesRuntimeByKey = new Map<string, EntriesRuntimeValue>();
const listenersByKey = new Map<string, Set<() => void>>();

const EntriesContext = createContext<EntriesContextType | null>(null);
const EntriesActionsContext = createContext<EntriesActionsContextType | null>(
  null
);

function touchRuntimeKey(key: string, value: EntriesRuntimeValue) {
  entriesRuntimeByKey.delete(key);
  entriesRuntimeByKey.set(key, value);
}

function evictInactiveRuntimeEntries() {
  if (entriesRuntimeByKey.size <= MAX_RUNTIME_CACHE_ENTRIES) {
    return;
  }
  for (const key of entriesRuntimeByKey.keys()) {
    if (entriesRuntimeByKey.size <= MAX_RUNTIME_CACHE_ENTRIES) {
      break;
    }
    if ((listenersByKey.get(key)?.size ?? 0) === 0) {
      entriesRuntimeByKey.delete(key);
    }
  }
}

function getRuntimeValue(key: string): EntriesRuntimeValue {
  const existing = entriesRuntimeByKey.get(key);
  if (!existing) {
    return EMPTY_RUNTIME_VALUE;
  }
  touchRuntimeKey(key, existing);
  return existing;
}

function writeRuntimeValue(key: string, value: EntriesRuntimeValue) {
  touchRuntimeKey(key, value);
  evictInactiveRuntimeEntries();
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
      if (localValueRef.current !== EMPTY_RUNTIME_VALUE) {
        localValueRef.current = EMPTY_RUNTIME_VALUE;
        setLocalValue(EMPTY_RUNTIME_VALUE);
      }
      return;
    }

    const sync = () => {
      const nextValue = getRuntimeValue(runtimeKey);
      if (localValueRef.current === nextValue) {
        return;
      }
      localValueRef.current = nextValue;
      setLocalValue(nextValue);
    };

    sync();
    return subscribeRuntimeValue(runtimeKey, sync);
  }, [runtimeKey]);

  const commitRuntimeUpdate = useCallback(
    (nextValue: EntriesRuntimeValue) => {
      localValueRef.current = nextValue;
      setLocalValue(nextValue);
      if (runtimeKey) {
        writeRuntimeValue(runtimeKey, nextValue);
      }
    },
    [runtimeKey]
  );

  const setEntries = useCallback(
    (newEntries: PatchTypeWithKey[]) => {
      if (
        localValueRef.current.entries === newEntries ||
        (localValueRef.current.entries.length === 0 && newEntries.length === 0)
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        entries: newEntries,
      });
    },
    [commitRuntimeUpdate]
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
      commitRuntimeUpdate({
        ...localValueRef.current,
        tokenUsageInfo: info,
      });
    },
    [commitRuntimeUpdate]
  );

  const setSessionModes = useCallback(
    (modes: ConversationSessionModesState) => {
      // Same no-op guard as token usage: the live timeline recomputes a fresh
      // modes object on each event; skip identical writes to avoid render loops.
      if (sessionModesEqual(localValueRef.current.sessionModes, modes)) {
        return;
      }
      const normalizedModes =
        modes.current === null && modes.modes.length === 0
          ? EMPTY_SESSION_MODES
          : modes;
      commitRuntimeUpdate({
        ...localValueRef.current,
        sessionModes: normalizedModes,
      });
    },
    [commitRuntimeUpdate]
  );

  const setSessionConfigOptions = useCallback(
    (options: AgentSessionConfigOption[]) => {
      if (
        sessionConfigOptionsEqual(
          localValueRef.current.sessionConfigOptions,
          options
        )
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        sessionConfigOptions:
          options.length === 0 ? EMPTY_SESSION_CONFIG_OPTIONS : options,
      });
    },
    [commitRuntimeUpdate]
  );

  const setConversationPlanEntries = useCallback(
    (entries: PlanEntry[]) => {
      if (
        planEntriesEqual(localValueRef.current.conversationPlanEntries, entries)
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        conversationPlanEntries:
          entries.length === 0 ? EMPTY_CONVERSATION_PLAN_ENTRIES : entries,
      });
    },
    [commitRuntimeUpdate]
  );

  const setConversationTurnInFlight = useCallback(
    (conversationTurnInFlight: boolean) => {
      if (
        localValueRef.current.conversationTurnInFlight ===
        conversationTurnInFlight
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        conversationTurnInFlight,
      });
    },
    [commitRuntimeUpdate]
  );

  const setConversationSteeringTurnId = useCallback(
    (conversationSteeringTurnId: string | null) => {
      if (
        localValueRef.current.conversationSteeringTurnId ===
        conversationSteeringTurnId
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        conversationSteeringTurnId,
      });
    },
    [commitRuntimeUpdate]
  );

  const setConversationSteeringTarget = useCallback(
    (conversationSteeringTarget: ComposerSteeringTarget | null) => {
      const current = localValueRef.current.conversationSteeringTarget;
      if (
        current?.turnId === conversationSteeringTarget?.turnId &&
        current?.mode === conversationSteeringTarget?.mode &&
        Boolean(current) === Boolean(conversationSteeringTarget)
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        conversationSteeringTarget,
      });
    },
    [commitRuntimeUpdate]
  );

  const setConversationDeliveryChannel = useCallback(
    (conversationDeliveryChannel: DeliveryChannel) => {
      if (
        localValueRef.current.conversationDeliveryChannel ===
        conversationDeliveryChannel
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        conversationDeliveryChannel,
      });
    },
    [commitRuntimeUpdate]
  );

  const setUserMessageHistory = useCallback(
    (messages: string[]) => {
      if (
        stringArraysEqual(localValueRef.current.userMessageHistory, messages)
      ) {
        return;
      }
      commitRuntimeUpdate({
        ...localValueRef.current,
        userMessageHistory:
          messages.length === 0 ? EMPTY_USER_MESSAGE_HISTORY : messages,
      });
    },
    [commitRuntimeUpdate]
  );

  const reset = useCallback(() => {
    if (localValueRef.current === EMPTY_RUNTIME_VALUE) {
      return;
    }
    commitRuntimeUpdate(EMPTY_RUNTIME_VALUE);
  }, [commitRuntimeUpdate]);

  const actionsValue = useMemo<EntriesActionsContextType>(
    () => ({
      setEntries,
      setTokenUsageInfo,
      setSessionModes,
      setSessionConfigOptions,
      setConversationPlanEntries,
      setConversationTurnInFlight,
      setConversationSteeringTurnId,
      setConversationSteeringTarget,
      setConversationDeliveryChannel,
      setUserMessageHistory,
      reset,
    }),
    [
      reset,
      setConversationDeliveryChannel,
      setConversationPlanEntries,
      setConversationSteeringTarget,
      setConversationSteeringTurnId,
      setConversationTurnInFlight,
      setEntries,
      setSessionConfigOptions,
      setSessionModes,
      setTokenUsageInfo,
      setUserMessageHistory,
    ]
  );

  const value = useMemo(
    () => ({
      entries: localValue.entries,
      ...actionsValue,
      tokenUsageInfo: localValue.tokenUsageInfo,
      sessionModes: localValue.sessionModes,
      sessionConfigOptions: localValue.sessionConfigOptions,
      conversationPlanEntries: localValue.conversationPlanEntries,
      conversationTurnInFlight: localValue.conversationTurnInFlight,
      conversationSteeringTurnId: localValue.conversationSteeringTurnId,
      conversationSteeringTarget: localValue.conversationSteeringTarget,
      conversationDeliveryChannel: localValue.conversationDeliveryChannel,
      userMessageHistory: localValue.userMessageHistory,
    }),
    [actionsValue, localValue]
  );

  return (
    <EntriesActionsContext.Provider value={actionsValue}>
      <EntriesContext.Provider value={value}>
        {children}
      </EntriesContext.Provider>
    </EntriesActionsContext.Provider>
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

/** Stable action-only accessor so writers do not re-render on entries/token updates. */
export const useOptionalEntriesActions = (): EntriesActionsContextType | null =>
  useContext(EntriesActionsContext);
