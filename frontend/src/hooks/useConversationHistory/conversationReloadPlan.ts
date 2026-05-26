import { ExecutionProcess, ExecutionProcessStatus } from 'shared/types';

type ConversationReloadPlanInput = {
  processes: ExecutionProcess[];
  displayedProcessIds: ReadonlySet<string>;
  previousStatusMap: ReadonlyMap<string, ExecutionProcessStatus>;
  loadingHistoricProcessIds: ReadonlySet<string>;
  loadedInitialEntries: boolean;
};

type ConversationReloadPlan = {
  processesToReload: ExecutionProcess[];
  lateHistoricProcesses: ExecutionProcess[];
  shouldEmitStoppedState: boolean;
  loadingHistoricProcessIdsToAdd: string[];
  nextPreviousStatuses: Array<[string, ExecutionProcessStatus]>;
};

export function getConversationReloadPlan({
  processes,
  displayedProcessIds,
  previousStatusMap,
  loadingHistoricProcessIds,
  loadedInitialEntries,
}: ConversationReloadPlanInput): ConversationReloadPlan {
  const processesToReload: ExecutionProcess[] = [];
  const lateHistoricProcesses: ExecutionProcess[] = [];
  const loadingHistoricProcessIdsToAdd: string[] = [];
  const nextPreviousStatuses: Array<[string, ExecutionProcessStatus]> = [];
  let shouldEmitStoppedState = false;

  for (const process of processes) {
    const previousStatus = previousStatusMap.get(process.id);
    const currentStatus = process.status;
    const isDisplayed = displayedProcessIds.has(process.id);
    const isRunning = currentStatus === ExecutionProcessStatus.running;

    if (
      previousStatus === ExecutionProcessStatus.running &&
      currentStatus !== ExecutionProcessStatus.running &&
      isDisplayed
    ) {
      shouldEmitStoppedState = true;
      processesToReload.push(process);
    }

    if (
      loadedInitialEntries &&
      !isRunning &&
      !isDisplayed &&
      !loadingHistoricProcessIds.has(process.id)
    ) {
      loadingHistoricProcessIdsToAdd.push(process.id);
      lateHistoricProcesses.push(process);
    }

    nextPreviousStatuses.push([process.id, currentStatus]);
  }

  return {
    processesToReload,
    lateHistoricProcesses,
    shouldEmitStoppedState,
    loadingHistoricProcessIdsToAdd,
    nextPreviousStatuses,
  };
}
