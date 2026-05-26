import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';
import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';
import type { PatchTypeWithKey } from './types';

type RunningStreamController = { close: () => void };

type RunningConversationStreamOptions = {
  executionProcess: ExecutionProcess;
  initialEntries: PatchType[];
  createStreamId: (executionProcessId: string) => string;
  getLiveProcessStatus: () => ExecutionProcessStatus | undefined;
  isLikelyStaleRunningSnapshot: (entries: PatchTypeWithKey[]) => boolean;
  onEntries: (entries: PatchTypeWithKey[]) => void;
  onFinished: () => void;
  closeExistingController: () => void;
  setActiveController: (controller: RunningStreamController) => void;
  clearActiveController: () => void;
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

export function loadRunningConversationStream({
  executionProcess,
  initialEntries,
  createStreamId,
  getLiveProcessStatus,
  isLikelyStaleRunningSnapshot,
  onEntries,
  onFinished,
  closeExistingController,
  setActiveController,
  clearActiveController,
}: RunningConversationStreamOptions): Promise<void> {
  const normalized = executionProcess.executor_action.typ.type !== 'ScriptRequest';
  const emptyRunningStreamRetryMs = 100;
  const maxEmptyRunningStreamRetries = 3;

  return new Promise((resolve, reject) => {
    closeExistingController();

    let controller: RunningStreamController | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let emptyStreamRetryCount = 0;

    const closeController = () => {
      if (closed) return;
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      clearActiveController();
      controller?.close();
    };

    const shouldRetryEmptyRunningStream = () => {
      return (
        getLiveProcessStatus() === ExecutionProcessStatus.running &&
        emptyStreamRetryCount < maxEmptyRunningStreamRetries
      );
    };

    const scheduleRetry = (startStream: () => void) => {
      emptyStreamRetryCount += 1;
      controller?.close();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        startStream();
      }, emptyRunningStreamRetryMs);
    };

    const startStream = () => {
      if (closed) return;

      let receivedEntries = false;
      controller = streamJsonPatchEntries<PatchType>(
        {
          executionProcessId: executionProcess.id,
          normalized,
          streamId: createStreamId(executionProcess.id),
        },
        {
          initial: {
            entries: initialEntries,
          },
          onEntries(entries) {
            const patchesWithKey = entries.map((entry, index) =>
              patchWithKey(entry, executionProcess.id, index)
            );
            if (isLikelyStaleRunningSnapshot(patchesWithKey)) {
              return;
            }

            receivedEntries = true;
            onEntries(patchesWithKey);
          },
          onFinished: () => {
            if (!receivedEntries && shouldRetryEmptyRunningStream()) {
              scheduleRetry(startStream);
              return;
            }

            onFinished();
            closeController();
            resolve();
          },
          onError: (err) => {
            if (!receivedEntries && shouldRetryEmptyRunningStream()) {
              scheduleRetry(startStream);
              return;
            }

            console.warn(
              `Error streaming entries for execution process ${executionProcess.id}`,
              err
            );
            closeController();
            reject(err);
          },
        }
      );
      setActiveController({ close: closeController });
    };

    startStream();
  });
}
