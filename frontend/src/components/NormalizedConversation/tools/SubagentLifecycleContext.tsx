import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { MessageTurn } from 'shared/types';
import { planTurnBlocks } from '../messageTurnBlocks';
import {
  collectSubagentLifecycleIndex,
  type SubagentLifecycleEvent,
} from './subagentCardModel';

export type SubagentLifecycleIndex = {
  events: SubagentLifecycleEvent[];
  spawnBindingIds: Set<string>;
};

const EMPTY_INDEX: SubagentLifecycleIndex = {
  events: [],
  spawnBindingIds: new Set(),
};

const SubagentLifecycleContext =
  createContext<SubagentLifecycleIndex>(EMPTY_INDEX);

export function useSubagentLifecycleIndex(): SubagentLifecycleIndex {
  return useContext(SubagentLifecycleContext);
}

export function indexSubagentLifecycleFromTurns(
  turns: MessageTurn[]
): SubagentLifecycleIndex {
  const tools = turns.flatMap((turn) =>
    planTurnBlocks(turn.blocks).flatMap((item) =>
      item.kind === 'tool' && item.use
        ? [{ use: item.use, result: item.result }]
        : []
    )
  );
  if (tools.length === 0) {
    return EMPTY_INDEX;
  }
  const next = collectSubagentLifecycleIndex(tools);
  if (next.events.length === 0 && next.spawnBindingIds.size === 0) {
    return EMPTY_INDEX;
  }
  return next;
}

function sameSubagentLifecycleEvent(
  a: SubagentLifecycleEvent,
  b: SubagentLifecycleEvent
): boolean {
  if (
    a.kind !== b.kind ||
    a.toolUseId !== b.toolUseId ||
    a.inFlight !== b.inFlight ||
    a.failed !== b.failed ||
    a.resultText !== b.resultText ||
    a.childStatus !== b.childStatus ||
    a.toolCallCount !== b.toolCallCount ||
    a.turnCount !== b.turnCount ||
    a.durationMs !== b.durationMs ||
    a.contextUsagePct !== b.contextUsagePct ||
    a.tokenCount !== b.tokenCount ||
    a.bindingIds.length !== b.bindingIds.length
  ) {
    return false;
  }
  for (let i = 0; i < a.bindingIds.length; i++) {
    if (a.bindingIds[i] !== b.bindingIds[i]) return false;
  }
  return true;
}

function sameSubagentLifecycleIndex(
  prev: SubagentLifecycleIndex,
  next: SubagentLifecycleIndex
): boolean {
  if (prev === next) return true;
  if (
    prev.events.length !== next.events.length ||
    prev.spawnBindingIds.size !== next.spawnBindingIds.size
  ) {
    return false;
  }
  for (const id of next.spawnBindingIds) {
    if (!prev.spawnBindingIds.has(id)) return false;
  }
  for (let i = 0; i < next.events.length; i += 1) {
    if (!sameSubagentLifecycleEvent(prev.events[i]!, next.events[i]!)) {
      return false;
    }
  }
  return true;
}

export function SubagentLifecycleProvider({
  turns,
  children,
}: {
  turns: MessageTurn[];
  children: ReactNode;
}) {
  const prevRef = useRef<SubagentLifecycleIndex>(EMPTY_INDEX);
  const value = useMemo(() => {
    const next = indexSubagentLifecycleFromTurns(turns);
    if (sameSubagentLifecycleIndex(prevRef.current, next)) {
      return prevRef.current;
    }
    prevRef.current = next;
    return next;
  }, [turns]);
  return (
    <SubagentLifecycleContext.Provider value={value}>
      {children}
    </SubagentLifecycleContext.Provider>
  );
}
