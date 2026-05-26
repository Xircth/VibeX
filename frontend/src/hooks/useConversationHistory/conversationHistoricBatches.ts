import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';
import type {
  ExecutionProcessState,
  ExecutionProcessStateStore,
  PatchTypeWithKey,
} from './types';

type LoadEntries = (executionProcess: ExecutionProcess) => Promise<PatchType[]>;

type HistoricBatchOptions = {
  processConcurrency: number;
  loadEntries: LoadEntries;
};

type InitialHistoricBatchOptions = HistoricBatchOptions & {
  minInitialEntries: number;
};

type RemainingHistoricBatchOptions = HistoricBatchOptions & {
  batchSize: number;
};

type RemainingHistoricBatchResult = {
  loadedStates: ExecutionProcessStateStore;
  shouldContinue: boolean;
};

function patchWithKey(
  patch: PatchType,
  executionProcessId: string,
  index: number | string
): PatchTypeWithKey {
  return {
    ...patch,
    patchKey: `${executionProcessId}:${index}`,
    executionProcessId,
  };
}

export function toConversationProcessState(
  executionProcess: ExecutionProcess,
  entries: PatchType[]
): ExecutionProcessState {
  return {
    executionProcess: {
      id: executionProcess.id,
      created_at: executionProcess.created_at,
      updated_at: executionProcess.updated_at,
      executor_action: executionProcess.executor_action,
    },
    entries: entries.map((entry, entryIndex) =>
      patchWithKey(entry, executionProcess.id, entryIndex)
    ),
  };
}

async function loadConversationProcessStates(
  processes: ExecutionProcess[],
  loadEntries: LoadEntries
): Promise<ExecutionProcessStateStore> {
  const loadedState: ExecutionProcessStateStore = {};
  const chunkEntries = await Promise.all(
    processes.map(async (executionProcess) => {
      const entries = await loadEntries(executionProcess);
      return toConversationProcessState(executionProcess, entries);
    })
  );

  chunkEntries.forEach((processState) => {
    loadedState[processState.executionProcess.id] = processState;
  });

  return loadedState;
}

function countEntries(processStateStore: ExecutionProcessStateStore): number {
  return Object.values(processStateStore).flatMap(
    (processState) => processState.entries
  ).length;
}

export async function loadInitialConversationProcessStates(
  processes: ExecutionProcess[],
  {
    processConcurrency,
    minInitialEntries,
    loadEntries,
  }: InitialHistoricBatchOptions
): Promise<ExecutionProcessStateStore> {
  const loadedState: ExecutionProcessStateStore = {};
  const historicProcesses = [...processes].reverse();

  for (
    let index = 0;
    index < historicProcesses.length;
    index += processConcurrency
  ) {
    const chunk = historicProcesses.slice(index, index + processConcurrency);
    Object.assign(loadedState, await loadConversationProcessStates(chunk, loadEntries));

    if (countEntries(loadedState) > minInitialEntries) {
      break;
    }
  }

  return loadedState;
}

export async function loadRemainingConversationProcessStates(
  processes: ExecutionProcess[],
  displayedState: ExecutionProcessStateStore,
  {
    processConcurrency,
    batchSize,
    loadEntries,
  }: RemainingHistoricBatchOptions
): Promise<RemainingHistoricBatchResult> {
  const remainingProcesses = [...processes]
    .reverse()
    .filter(
      (executionProcess) =>
        !displayedState[executionProcess.id] &&
        executionProcess.status !== ExecutionProcessStatus.running
    );

  if (remainingProcesses.length === 0) {
    return {
      loadedStates: {},
      shouldContinue: false,
    };
  }

  const chunk = remainingProcesses.slice(0, processConcurrency);
  const loadedStates = await loadConversationProcessStates(chunk, loadEntries);
  const totalEntries =
    countEntries(displayedState) + countEntries(loadedStates);

  return {
    loadedStates,
    shouldContinue: totalEntries > batchSize || chunk.length > 0,
  };
}
