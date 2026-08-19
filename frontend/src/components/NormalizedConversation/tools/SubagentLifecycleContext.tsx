import { createContext, useContext, useMemo, type ReactNode } from 'react';
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
  return collectSubagentLifecycleIndex(tools);
}

export function SubagentLifecycleProvider({
  turns,
  children,
}: {
  turns: MessageTurn[];
  children: ReactNode;
}) {
  const value = useMemo(() => indexSubagentLifecycleFromTurns(turns), [turns]);
  return (
    <SubagentLifecycleContext.Provider value={value}>
      {children}
    </SubagentLifecycleContext.Provider>
  );
}
