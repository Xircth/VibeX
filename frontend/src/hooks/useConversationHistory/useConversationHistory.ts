import {
  ExecutionProcess,
  ExecutionProcessStatus,
  NormalizedEntry,
  PatchType,
  QueueStatus,
} from 'shared/types';
import { useQuery } from '@tanstack/react-query';
import { queueApi } from '@/lib/api';
import { dateTimestamp } from '@/utils/date';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildSessionConversationKey } from '@/lib/conversationKeys';
import type {
  AddEntryType,
  ExecutionProcessStateStore,
  OnEntriesUpdated,
  PatchTypeWithKey,
  UseConversationHistoryParams,
  UseConversationHistoryResult,
} from './types';
import {
  MIN_INITIAL_ENTRIES,
  nextActionPatch,
  REMAINING_BATCH_SIZE,
} from './constants';
import {
  createConversationStreamId,
  getConversationRuntimeState,
  rememberConversationHistoryState,
} from './conversationRuntimeStore';
import {
  isLikelyStaleRunningSnapshot as isLikelyStaleSnapshotFromStore,
} from './conversationSnapshotStaleness';
import { getLatestConversationTokenUsage } from './conversationTokenUsage';
import { getConversationEmitAddType } from './conversationEmitAddType';
import { getConversationScriptDisplay } from './conversationScriptDisplay';
import { getConversationCodingAgentDisplay } from './conversationCodingAgentDisplay';
import { loadHistoricExecutionProcessEntries } from './conversationHistoricEntriesLoader';
import { getConversationReloadPlan } from './conversationReloadPlan';
import { loadRunningConversationStream } from './conversationRunningStream';
import {
  loadInitialConversationProcessStates,
  loadRemainingConversationProcessStates,
  toConversationProcessState,
} from './conversationHistoricBatches';
import { getConversationRemovalPlan } from './conversationRemovalPlan';
export { clearConversationRuntimeForTests } from './conversationRuntimeStore';
export { stripPreviouslyDisplayedAssistantPrefix } from './conversationCodingAgentDisplay';

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty' };

function stripDisplayEntryMetadata(entry: PatchTypeWithKey): PatchType {
  return {
    type: entry.type,
    content: entry.content,
  } as PatchType;
}

export const useConversationHistory = ({
  attempt,
  onEntriesUpdated,
}: UseConversationHistoryParams): UseConversationHistoryResult => {
  const HISTORIC_PROCESS_CONCURRENCY = 4;
  const sessionId = attempt.session?.id;
  const conversationKey = buildSessionConversationKey(attempt.id, sessionId);
  const {
    executionProcessesVisible: executionProcessesRaw,
    isLoading: executionProcessesLoading,
    error: executionProcessesError,
  } = useExecutionProcessesContext();
  const { setTokenUsageInfo } = useEntries();
  const executionProcesses = useRef<ExecutionProcess[]>(executionProcessesRaw);
  const displayedExecutionProcesses = useRef<ExecutionProcessStateStore>({});
  const loadedInitialEntries = useRef(false);
  const [initialLoadVersion, setInitialLoadVersion] = useState(0);
  const streamingProcessIdsRef = useRef<Set<string>>(new Set());
  const activeStreamControllersRef = useRef<Map<string, { close: () => void }>>(
    new Map()
  );
  const onEntriesUpdatedRef = useRef<OnEntriesUpdated | null>(null);
  const previousStatusMapRef = useRef<Map<string, ExecutionProcessStatus>>(
    new Map()
  );
  const loadingHistoricProcessIdsRef = useRef<Set<string>>(new Set());
  const prevConversationKeyRef = useRef<string | null>(null);
  const saveConversationRuntime = useCallback((key: string | null) => {
    if (!key) return;

    const processIdsKey = executionProcesses.current.map((p) => p.id).join(',');
    rememberConversationHistoryState(
      key,
      displayedExecutionProcesses.current,
      processIdsKey,
      previousStatusMapRef.current,
      { clone: true }
    );
  }, []);
  const { data: queueStatus } = useQuery({
    queryKey: ['queue-status', sessionId],
    queryFn: () =>
      sessionId
        ? queueApi.getStatus(sessionId)
        : Promise.resolve(EMPTY_QUEUE_STATUS),
    enabled: !!sessionId,
  });

  const mergeIntoDisplayed = (
    mutator: (state: ExecutionProcessStateStore) => void
  ) => {
    const state = displayedExecutionProcesses.current;
    mutator(state);
  };

  const closeAllRunningStreams = useCallback(() => {
    for (const controller of activeStreamControllersRef.current.values()) {
      controller.close();
    }
    activeStreamControllersRef.current.clear();
    streamingProcessIdsRef.current.clear();
  }, []);

  useEffect(() => {
    onEntriesUpdatedRef.current = onEntriesUpdated;
  }, [onEntriesUpdated]);

  // Keep executionProcesses up to date
  useEffect(() => {
    executionProcesses.current = executionProcessesRaw.filter(
      (ep) =>
        ep.run_reason === 'setupscript' ||
        ep.run_reason === 'cleanupscript' ||
        ep.run_reason === 'archivescript' ||
        ep.run_reason === 'codingagent'
    );
  }, [executionProcessesRaw]);

  const getLiveExecutionProcess = (
    executionProcessId: string
  ): ExecutionProcess | undefined => {
    return executionProcesses?.current.find(
      (executionProcess) => executionProcess.id === executionProcessId
    );
  };

  const isLikelyStaleRunningSnapshot = useCallback(
    (executionProcessId: string, entries: PatchTypeWithKey[]): boolean => {
      return isLikelyStaleSnapshotFromStore(
        executionProcessId,
        entries,
        displayedExecutionProcesses.current
      );
    },
    []
  );

  const getActiveAgentProcesses = (): ExecutionProcess[] => {
    return (
      executionProcesses?.current.filter(
        (p) =>
          p.status === ExecutionProcessStatus.running &&
          p.run_reason !== 'devserver'
      ) ?? []
    );
  };

  const flattenEntriesForEmit = useCallback(
    (executionProcessState: ExecutionProcessStateStore): PatchTypeWithKey[] => {
      // Flags to control Next Action bar emit
      let hasPendingApproval = false;
      let hasRunningProcess = false;
      let lastProcessFailedOrKilled = false;
      let needsSetup = false;
      let setupHelpText: string | undefined;

      // Create user messages + tool calls for setup/cleanup scripts
      let previousAssistantTranscript = '';
      const allEntries = Object.values(executionProcessState)
        .sort(
          (a, b) =>
            dateTimestamp(a.executionProcess.created_at) -
            dateTimestamp(b.executionProcess.created_at)
        )
        .flatMap((p, index) => {
          const entries: PatchTypeWithKey[] = [];
          if (
            p.executionProcess.executor_action.typ.type ===
              'CodingAgentInitialRequest' ||
            p.executionProcess.executor_action.typ.type ===
              'CodingAgentFollowUpRequest' ||
            p.executionProcess.executor_action.typ.type === 'ReviewRequest'
          ) {
            const agentDisplay = getConversationCodingAgentDisplay(p, {
              previousAssistantTranscript,
              liveProcessStatus: getLiveExecutionProcess(p.executionProcess.id)
                ?.status,
            });

            if (!agentDisplay) {
              return entries;
            }

            if (agentDisplay.hasPendingApproval) {
              hasPendingApproval = true;
            }

            entries.push(...agentDisplay.entries);
            previousAssistantTranscript = agentDisplay.nextAssistantTranscript;

            if (agentDisplay.isRunning) {
              hasRunningProcess = true;
            }

            if (
              agentDisplay.isFailedOrKilled &&
              index === Object.keys(executionProcessState).length - 1
            ) {
              lastProcessFailedOrKilled = true;

              if (agentDisplay.setupHelpText) {
                needsSetup = true;
                setupHelpText = agentDisplay.setupHelpText;
              }
            }
          } else if (
            p.executionProcess.executor_action.typ.type === 'ScriptRequest'
          ) {
            const scriptDisplay = getConversationScriptDisplay(
              p,
              getLiveExecutionProcess(p.executionProcess.id)
            );

            if (!scriptDisplay) {
              return [];
            }

            if (scriptDisplay.isRunning) {
              hasRunningProcess = true;
            }

            if (
              scriptDisplay.isFailedOrKilled &&
              index === Object.keys(executionProcessState).length - 1
            ) {
              lastProcessFailedOrKilled = true;
            }

            entries.push(scriptDisplay.entry);
          }

          return entries;
        });

      // Emit the next action bar if no process running
      if (!hasRunningProcess && !hasPendingApproval) {
        allEntries.push(
          nextActionPatch(
            lastProcessFailedOrKilled,
            Object.keys(executionProcessState).length,
            needsSetup,
            setupHelpText
          )
        );
      }

      if (
        queueStatus?.status === 'queued' &&
        queueStatus.message.data.message
      ) {
        const queuedEntry: NormalizedEntry = {
          entry_type: {
            type: 'user_message',
          },
          content: queueStatus.message.data.message,
          timestamp: null,
        };

        allEntries.push({
          type: 'NORMALIZED_ENTRY',
          content: queuedEntry,
          patchKey: `queued:${queueStatus.message.session_id}`,
          executionProcessId: `queued:${queueStatus.message.session_id}`,
        });
      }

      return allEntries;
    },
    [queueStatus]
  );

  const emitEntries = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore,
      addEntryType: AddEntryType,
      loading: boolean
    ) => {
      const entries = flattenEntriesForEmit(executionProcessState);
      const latestTokenUsageInfo =
        getLatestConversationTokenUsage(executionProcessState);

      setTokenUsageInfo(latestTokenUsageInfo);
      rememberConversationHistoryState(
        conversationKey,
        executionProcessState,
        executionProcesses.current.map((process) => process.id).join(','),
        previousStatusMapRef.current,
        { clone: false }
      );
      const modifiedAddEntryType = getConversationEmitAddType(
        entries,
        addEntryType
      );

      onEntriesUpdatedRef.current?.(entries, modifiedAddEntryType, loading);
    },
    [conversationKey, flattenEntriesForEmit, setTokenUsageInfo]
  );

  // This emits its own events as they are streamed via Tauri Events
  const loadRunningAndEmit = useCallback(
    (executionProcess: ExecutionProcess): Promise<void> => {
      return loadRunningConversationStream({
        executionProcess,
        initialEntries:
          displayedExecutionProcesses.current[
            executionProcess.id
          ]?.entries.map(stripDisplayEntryMetadata) ?? [],
        createStreamId: createConversationStreamId,
        getLiveProcessStatus: () =>
          getLiveExecutionProcess(executionProcess.id)?.status,
        isLikelyStaleRunningSnapshot: (entries) =>
          isLikelyStaleRunningSnapshot(executionProcess.id, entries),
        onEntries: (entries) => {
          mergeIntoDisplayed((state) => {
            state[executionProcess.id] = {
              executionProcess,
              entries,
            };
          });
          emitEntries(displayedExecutionProcesses.current, 'running', false);
        },
        onFinished: () => {
          emitEntries(displayedExecutionProcesses.current, 'running', false);
        },
        closeExistingController: () => {
          activeStreamControllersRef.current.get(executionProcess.id)?.close();
          activeStreamControllersRef.current.delete(executionProcess.id);
        },
        setActiveController: (controller) => {
          activeStreamControllersRef.current.set(executionProcess.id, controller);
        },
        clearActiveController: () => {
          activeStreamControllersRef.current.delete(executionProcess.id);
        },
      });
    },
    [emitEntries, isLikelyStaleRunningSnapshot]
  );

  const loadInitialEntries =
    useCallback(async (): Promise<ExecutionProcessStateStore> => {
      if (!executionProcesses?.current) return {};

      return loadInitialConversationProcessStates(executionProcesses.current, {
        processConcurrency: HISTORIC_PROCESS_CONCURRENCY,
        minInitialEntries: MIN_INITIAL_ENTRIES,
        loadEntries: loadHistoricExecutionProcessEntries,
      });
    }, [executionProcesses]);

  const loadRemainingEntriesInBatches = useCallback(
    async (batchSize: number): Promise<boolean> => {
      if (!executionProcesses?.current) return false;

      const result = await loadRemainingConversationProcessStates(
        executionProcesses.current,
        displayedExecutionProcesses.current,
        {
          processConcurrency: HISTORIC_PROCESS_CONCURRENCY,
          batchSize,
          loadEntries: loadHistoricExecutionProcessEntries,
        }
      );

      mergeIntoDisplayed((state) => {
        Object.assign(state, result.loadedStates);
      });

      return result.shouldContinue;
    },
    [executionProcesses]
  );

  const ensureProcessVisible = useCallback((p: ExecutionProcess) => {
    mergeIntoDisplayed((state) => {
      if (!state[p.id]) {
        state[p.id] = {
          executionProcess: {
            id: p.id,
            created_at: p.created_at,
            updated_at: p.updated_at,
            executor_action: p.executor_action,
          },
          entries: [],
        };
      }
    });
  }, []);

  const idListKey = useMemo(
    () => executionProcessesRaw?.map((p) => p.id).join(','),
    [executionProcessesRaw]
  );

  const idStatusKey = useMemo(
    () => executionProcessesRaw?.map((p) => `${p.id}:${p.status}`).join(','),
    [executionProcessesRaw]
  );

  // Reset state when the active workspace/session conversation changes.
  // This must run before initial history loading and running stream subscription
  // effects so reconnects do not start from an empty process snapshot.
  useEffect(() => {
    if (prevConversationKeyRef.current === conversationKey) return;
    saveConversationRuntime(prevConversationKeyRef.current);
    prevConversationKeyRef.current = conversationKey;

    closeAllRunningStreams();
    const existingRuntime = getConversationRuntimeState(conversationKey);

    if (existingRuntime) {
      displayedExecutionProcesses.current = structuredClone(
        existingRuntime.displayedExecutionProcesses
      );
      previousStatusMapRef.current = new Map(existingRuntime.previousStatusMap);
      // Always refresh from latest process list after switching conversations.
      loadedInitialEntries.current = false;
      setInitialLoadVersion((version) => version + 1);

      const hasRuntimeEntries = Object.values(
        displayedExecutionProcesses.current
      ).some((processState) => processState.entries.length > 0);
      const hasNoHistory =
        !executionProcessesLoading && executionProcessesRaw.length === 0;
      emitEntries(
        displayedExecutionProcesses.current,
        'initial',
        !hasRuntimeEntries && !hasNoHistory
      );
      return;
    }

    displayedExecutionProcesses.current = {};
    loadedInitialEntries.current = false;
    setInitialLoadVersion((version) => version + 1);
    loadingHistoricProcessIdsRef.current.clear();
    previousStatusMapRef.current.clear();
    const hasNoHistory =
      !executionProcessesLoading && executionProcessesRaw.length === 0;
    emitEntries(displayedExecutionProcesses.current, 'initial', !hasNoHistory);
  }, [
    conversationKey,
    idListKey,
    emitEntries,
    executionProcessesLoading,
    executionProcessesRaw.length,
    closeAllRunningStreams,
    saveConversationRuntime,
    setTokenUsageInfo,
  ]);

  // Initial load when attempt changes
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const hasLoadedForCurrentProcessSet = loadedInitialEntries.current;

      if (executionProcessesLoading || hasLoadedForCurrentProcessSet) {
        return;
      }

      if (executionProcessesRaw.length === 0) {
        loadedInitialEntries.current = true;
        setInitialLoadVersion((version) => version + 1);
        emitEntries(displayedExecutionProcesses.current, 'initial', false);
        return;
      }

      // Initial entries
      const allInitialEntries = await loadInitialEntries();
      if (cancelled) return;
      mergeIntoDisplayed((state) => {
        Object.assign(state, allInitialEntries);
      });
      emitEntries(displayedExecutionProcesses.current, 'initial', false);
      loadedInitialEntries.current = true;
      setInitialLoadVersion((version) => version + 1);

      // Then load the remaining in batches
      while (
        !cancelled &&
        (await loadRemainingEntriesInBatches(REMAINING_BATCH_SIZE))
      ) {
        if (cancelled) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attempt.id,
    conversationKey,
    executionProcessesRaw.length,
    executionProcessesLoading,
    loadInitialEntries,
    loadRemainingEntriesInBatches,
    emitEntries,
    setTokenUsageInfo,
  ]);

  useEffect(() => {
    if (!loadedInitialEntries.current && executionProcessesRaw.length > 0) {
      return;
    }

    const activeProcesses = getActiveAgentProcesses();
    if (activeProcesses.length === 0) return;

    for (const activeProcess of activeProcesses) {
      if (!displayedExecutionProcesses.current[activeProcess.id]) {
        const runningOrInitial =
          Object.keys(displayedExecutionProcesses.current).length > 1
            ? 'running'
            : 'initial';
        ensureProcessVisible(activeProcess);
        emitEntries(
          displayedExecutionProcesses.current,
          runningOrInitial,
          false
        );
      }

      if (
        activeProcess.status === ExecutionProcessStatus.running &&
        !streamingProcessIdsRef.current.has(activeProcess.id)
      ) {
        streamingProcessIdsRef.current.add(activeProcess.id);
        loadRunningAndEmit(activeProcess).finally(() => {
          streamingProcessIdsRef.current.delete(activeProcess.id);
        });
      }
    }
  }, [
    attempt.id,
    idStatusKey,
    initialLoadVersion,
    executionProcessesRaw.length,
    emitEntries,
    ensureProcessVisible,
    loadRunningAndEmit,
  ]);

  useEffect(() => {
    if (!executionProcessesRaw) return;

    const reloadPlan = getConversationReloadPlan({
      processes: executionProcessesRaw,
      displayedProcessIds: new Set(
        Object.keys(displayedExecutionProcesses.current)
      ),
      previousStatusMap: previousStatusMapRef.current,
      loadingHistoricProcessIds: loadingHistoricProcessIdsRef.current,
      loadedInitialEntries: loadedInitialEntries.current,
    });

    for (const process of reloadPlan.processesToReload) {
      const activeStreamController = activeStreamControllersRef.current.get(
        process.id
      );
      if (activeStreamController) {
        activeStreamController.close();
        activeStreamControllersRef.current.delete(process.id);
        streamingProcessIdsRef.current.delete(process.id);
      }
    }

    for (const processId of reloadPlan.loadingHistoricProcessIdsToAdd) {
      loadingHistoricProcessIdsRef.current.add(processId);
    }

    for (const [processId, status] of reloadPlan.nextPreviousStatuses) {
      previousStatusMapRef.current.set(processId, status);
    }

    if (reloadPlan.shouldEmitStoppedState) {
      emitEntries(displayedExecutionProcesses.current, 'running', false);
    }

    const reloadTargets = [
      ...reloadPlan.processesToReload,
      ...reloadPlan.lateHistoricProcesses,
    ];
    if (reloadTargets.length === 0) return;

    (async () => {
      let anyUpdated = false;

      for (const process of reloadTargets) {
        const entries = await loadHistoricExecutionProcessEntries(process);
        loadingHistoricProcessIdsRef.current.delete(process.id);

        mergeIntoDisplayed((state) => {
          state[process.id] = toConversationProcessState(process, entries);
        });
        anyUpdated = true;
      }

      if (anyUpdated) {
        emitEntries(displayedExecutionProcesses.current, 'running', false);
      }
    })();
  }, [executionProcessesRaw, emitEntries, idStatusKey]);

  // If an execution process is removed, remove it from the state
  useEffect(() => {
    if (!executionProcessesRaw) return;
    const removedProcessIds = getConversationRemovalPlan({
      displayedProcessIds: Object.keys(displayedExecutionProcesses.current),
      visibleProcessIds: executionProcessesRaw.map((process) => process.id),
      isLoading: executionProcessesLoading,
      hasError: !!executionProcessesError,
    });

    if (removedProcessIds.length > 0) {
      mergeIntoDisplayed((state) => {
        removedProcessIds.forEach((id) => {
          delete state[id];
          previousStatusMapRef.current.delete(id);
          loadingHistoricProcessIdsRef.current.delete(id);
          streamingProcessIdsRef.current.delete(id);
          activeStreamControllersRef.current.get(id)?.close();
          activeStreamControllersRef.current.delete(id);
        });
      });
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    }
  }, [
    conversationKey,
    emitEntries,
    idListKey,
    executionProcessesRaw,
    executionProcessesLoading,
    executionProcessesError,
  ]);

  useEffect(() => {
    if (!executionProcessesLoading) {
      return;
    }

    const timeout = setTimeout(() => {
      if (executionProcessesLoading) {
        emitEntries(displayedExecutionProcesses.current, 'initial', false);
      }
    }, 4000);

    return () => {
      clearTimeout(timeout);
    };
  }, [conversationKey, executionProcessesLoading, emitEntries]);

  useEffect(
    () => () => {
      saveConversationRuntime(
        prevConversationKeyRef.current ?? conversationKey
      );
      loadingHistoricProcessIdsRef.current.clear();
      closeAllRunningStreams();
    },
    [closeAllRunningStreams, conversationKey, saveConversationRuntime]
  );

  return {};
};
