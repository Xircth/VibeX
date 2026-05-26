import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';
import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';

export function loadHistoricExecutionProcessEntries(
  executionProcess: ExecutionProcess
): Promise<PatchType[]> {
  const normalized = executionProcess.executor_action.typ.type !== 'ScriptRequest';
  const isRunningSnapshot =
    executionProcess.status === ExecutionProcessStatus.running;
  const historicStreamIdleTimeoutMs = isRunningSnapshot ? 50 : 200;
  const historicStreamMaxWaitMs = isRunningSnapshot ? 100 : 8000;

  return new Promise<PatchType[]>((resolve) => {
    let settled = false;
    let latestEntries: PatchType[] = [];
    let controller: { close: () => void } | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (maxTimer) {
        clearTimeout(maxTimer);
        maxTimer = null;
      }
    };

    const settle = (entries: PatchType[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      controller?.close();
      resolve(entries);
    };

    const scheduleIdleTimeout = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        settle(latestEntries);
      }, historicStreamIdleTimeoutMs);
    };

    maxTimer = setTimeout(() => {
      settle(latestEntries);
    }, historicStreamMaxWaitMs);

    controller = streamJsonPatchEntries<PatchType>(
      {
        executionProcessId: executionProcess.id,
        normalized,
      },
      {
        onEntries: (entries) => {
          latestEntries = entries;
          scheduleIdleTimeout();
        },
        onFinished: (allEntries) => {
          latestEntries = allEntries;
          settle(allEntries);
        },
        onError: (err) => {
          console.warn(
            `Error loading entries for historic execution process ${executionProcess.id}`,
            err
          );
          settle(latestEntries);
        },
      }
    );
  });
}
