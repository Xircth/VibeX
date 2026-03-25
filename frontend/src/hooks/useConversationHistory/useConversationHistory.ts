import {
  CommandExitStatus,
  ExecutionProcess,
  ExecutionProcessStatus,
  NormalizedEntry,
  PatchType,
  QueueStatus,
  TokenUsageInfo,
  ToolStatus,
} from 'shared/types';
import { useQuery } from '@tanstack/react-query';
import { queueApi } from '@/lib/api';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import { useEntries } from '@/contexts/EntriesContext';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { streamJsonPatchEntries } from '@/utils/streamJsonPatchEntries';
import type {
  AddEntryType,
  ExecutionProcessStateStore,
  OnEntriesUpdated,
  PatchTypeWithKey,
  UseConversationHistoryParams,
  UseConversationHistoryResult,
} from './types';
import {
  makeLoadingPatch,
  MIN_INITIAL_ENTRIES,
  nextActionPatch,
  REMAINING_BATCH_SIZE,
} from './constants';

const EMPTY_QUEUE_STATUS: QueueStatus = { status: 'empty' };

export const useConversationHistory = ({
  attempt,
  onEntriesUpdated,
}: UseConversationHistoryParams): UseConversationHistoryResult => {
  const HISTORIC_PROCESS_CONCURRENCY = 4;
  const sessionId = attempt.session?.id;
  const conversationKey = `${attempt.id}:${sessionId ?? 'no-session'}`;
  const {
    executionProcessesVisible: executionProcessesRaw,
    isLoading: executionProcessesLoading,
  } = useExecutionProcessesContext();
  const { setTokenUsageInfo } = useEntries();
  const executionProcesses = useRef<ExecutionProcess[]>(executionProcessesRaw);
  const displayedExecutionProcesses = useRef<ExecutionProcessStateStore>({});
  const loadedInitialEntries = useRef(false);
  const streamingProcessIdsRef = useRef<Set<string>>(new Set());
  const activeStreamControllersRef = useRef<Map<string, { close: () => void }>>(
    new Map()
  );
  const onEntriesUpdatedRef = useRef<OnEntriesUpdated | null>(null);
  const previousStatusMapRef = useRef<Map<string, ExecutionProcessStatus>>(
    new Map()
  );
  const prevConversationKeyRef = useRef<string | null>(null);
  const { data: queueStatus } = useQuery({
    queryKey: ['queue-status', sessionId],
    queryFn: () =>
      sessionId ? queueApi.getStatus(sessionId) : Promise.resolve(EMPTY_QUEUE_STATUS),
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

  const loadEntriesForHistoricExecutionProcess = (
    executionProcess: ExecutionProcess
  ) => {
    const normalized =
      executionProcess.executor_action.typ.type !== 'ScriptRequest';

    return new Promise<PatchType[]>((resolve) => {
      const controller = streamJsonPatchEntries<PatchType>(
        {
          executionProcessId: executionProcess.id,
          normalized,
        },
        {
          onFinished: (allEntries) => {
            controller.close();
            resolve(allEntries);
          },
          onError: (err) => {
            console.warn(
              `Error loading entries for historic execution process ${executionProcess.id}`,
              err
            );
            controller.close();
            resolve([]);
          },
        }
      );
    });
  };

  const getLiveExecutionProcess = (
    executionProcessId: string
  ): ExecutionProcess | undefined => {
    return executionProcesses?.current.find(
      (executionProcess) => executionProcess.id === executionProcessId
    );
  };

  const patchWithKey = (
    patch: PatchType,
    executionProcessId: string,
    index: number | 'user'
  ) => {
    return {
      ...patch,
      patchKey: `${executionProcessId}:${index}`,
      executionProcessId,
    };
  };

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
      const allEntries = Object.values(executionProcessState)
        .sort(
          (a, b) =>
            new Date(
              a.executionProcess.created_at as unknown as string
            ).getTime() -
            new Date(
              b.executionProcess.created_at as unknown as string
            ).getTime()
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
            // New user message
            const actionType = p.executionProcess.executor_action.typ;
            const userNormalizedEntry: NormalizedEntry = {
              entry_type: {
                type: 'user_message',
              },
              content: actionType.prompt,
              timestamp: null,
            };
            const userPatch: PatchType = {
              type: 'NORMALIZED_ENTRY',
              content: userNormalizedEntry,
            };
            const userPatchTypeWithKey = patchWithKey(
              userPatch,
              p.executionProcess.id,
              'user'
            );
            entries.push(userPatchTypeWithKey);

            // Remove user messages (replaced with custom one) and token usage info (displayed separately)
            const filteredEntries = p.entries.filter(
              (e) =>
                e.type !== 'NORMALIZED_ENTRY' ||
                (e.content.entry_type.type !== 'user_message' &&
                  e.content.entry_type.type !== 'token_usage_info')
            );

            const hasPendingApprovalEntry = filteredEntries.some((entry) => {
              if (entry.type !== 'NORMALIZED_ENTRY') return false;
              const entryType = entry.content.entry_type;
              return (
                entryType.type === 'tool_use' &&
                entryType.status.status === 'pending_approval'
              );
            });

            if (hasPendingApprovalEntry) {
              hasPendingApproval = true;
            }

            entries.push(...filteredEntries);

            const liveProcessStatus = getLiveExecutionProcess(
              p.executionProcess.id
            )?.status;
            const isProcessRunning =
              liveProcessStatus === ExecutionProcessStatus.running;
            const processFailedOrKilled =
              liveProcessStatus === ExecutionProcessStatus.failed ||
              liveProcessStatus === ExecutionProcessStatus.killed;

            if (isProcessRunning) {
              hasRunningProcess = true;
            }

            if (
              processFailedOrKilled &&
              index === Object.keys(executionProcessState).length - 1
            ) {
              lastProcessFailedOrKilled = true;

              // Check if this failed process has a SetupRequired entry
              const hasSetupRequired = filteredEntries.some((entry) => {
                if (entry.type !== 'NORMALIZED_ENTRY') return false;
                if (
                  entry.content.entry_type.type === 'error_message' &&
                  entry.content.entry_type.error_type.type === 'setup_required'
                ) {
                  setupHelpText = entry.content.content;
                  return true;
                }
                return false;
              });

              if (hasSetupRequired) {
                needsSetup = true;
              }
            }

            if (isProcessRunning && !hasPendingApprovalEntry) {
              entries.push(makeLoadingPatch(p.executionProcess.id));
            }
          } else if (
            p.executionProcess.executor_action.typ.type === 'ScriptRequest'
          ) {
            // Add setup and cleanup script as a tool call
            let toolName = '';
            switch (p.executionProcess.executor_action.typ.context) {
              case 'SetupScript':
                toolName = 'Setup Script';
                break;
              case 'CleanupScript':
                toolName = 'Cleanup Script';
                break;
              case 'ArchiveScript':
                toolName = 'Archive Script';
                break;
              case 'ToolInstallScript':
                toolName = 'Tool Install Script';
                break;
              default:
                return [];
            }

            const executionProcess = getLiveExecutionProcess(
              p.executionProcess.id
            );

            if (executionProcess?.status === ExecutionProcessStatus.running) {
              hasRunningProcess = true;
            }

            if (
              (executionProcess?.status === ExecutionProcessStatus.failed ||
                executionProcess?.status === ExecutionProcessStatus.killed) &&
              index === Object.keys(executionProcessState).length - 1
            ) {
              lastProcessFailedOrKilled = true;
            }

            const exitCode = Number(executionProcess?.exit_code) || 0;
            const exit_status: CommandExitStatus | null =
              executionProcess?.status === 'running'
                ? null
                : {
                    type: 'exit_code',
                    code: exitCode,
                  };

            const toolStatus: ToolStatus =
              executionProcess?.status === ExecutionProcessStatus.running
                ? { status: 'created' }
                : exitCode === 0
                  ? { status: 'success' }
                  : { status: 'failed' };

            const output = p.entries.map((line) => line.content).join('\n');

            const toolNormalizedEntry: NormalizedEntry = {
              entry_type: {
                type: 'tool_use',
                tool_name: toolName,
                action_type: {
                  action: 'command_run',
                  command: p.executionProcess.executor_action.typ.script,
                  result: {
                    output,
                    exit_status,
                  },
                },
                status: toolStatus,
              },
              content: toolName,
              timestamp: null,
            };
            const toolPatch: PatchType = {
              type: 'NORMALIZED_ENTRY',
              content: toolNormalizedEntry,
            };
            const toolPatchWithKey: PatchTypeWithKey = patchWithKey(
              toolPatch,
              p.executionProcess.id,
              0
            );

            entries.push(toolPatchWithKey);
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

      if (queueStatus?.status === 'queued' && queueStatus.message.data.message) {
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
      const orderedProcesses = Object.values(executionProcessState).sort(
        (a, b) =>
          new Date(a.executionProcess.created_at as unknown as string).getTime() -
          new Date(b.executionProcess.created_at as unknown as string).getTime()
      );
      let latestTokenUsageInfo: TokenUsageInfo | null = null;

      for (
        let processIndex = orderedProcesses.length - 1;
        processIndex >= 0 && !latestTokenUsageInfo;
        processIndex--
      ) {
        const process = orderedProcesses[processIndex];
        for (let entryIndex = process.entries.length - 1; entryIndex >= 0; entryIndex--) {
          const entry = process.entries[entryIndex];
          if (
            entry.type === 'NORMALIZED_ENTRY' &&
            entry.content.entry_type.type === 'token_usage_info'
          ) {
            latestTokenUsageInfo = entry.content.entry_type;
            break;
          }
        }
      }

      setTokenUsageInfo(latestTokenUsageInfo);
      let modifiedAddEntryType = addEntryType;

      // Modify so that if add entry type is 'running' and last entry is a plan, emit special plan type
      if (entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        if (
          lastEntry.type === 'NORMALIZED_ENTRY' &&
          lastEntry.content.entry_type.type === 'tool_use' &&
          lastEntry.content.entry_type.tool_name === 'ExitPlanMode'
        ) {
          modifiedAddEntryType = 'plan';
        }
      }

      onEntriesUpdatedRef.current?.(entries, modifiedAddEntryType, loading);
    },
    [flattenEntriesForEmit, setTokenUsageInfo]
  );

  // This emits its own events as they are streamed via Tauri Events
  const loadRunningAndEmit = useCallback(
    (executionProcess: ExecutionProcess): Promise<void> => {
      const normalized =
        executionProcess.executor_action.typ.type !== 'ScriptRequest';

      return new Promise((resolve, reject) => {
        activeStreamControllersRef.current.get(executionProcess.id)?.close();
        activeStreamControllersRef.current.delete(executionProcess.id);

        let controller: { close: () => void } | null = null;
        let closed = false;
        const closeController = () => {
          if (closed) return;
          closed = true;
          activeStreamControllersRef.current.delete(executionProcess.id);
          controller?.close();
        };

        controller = streamJsonPatchEntries<PatchType>(
          {
            executionProcessId: executionProcess.id,
            normalized,
          },
          {
            onEntries(entries) {
              const patchesWithKey = entries.map((entry, index) =>
                patchWithKey(entry, executionProcess.id, index)
              );
              mergeIntoDisplayed((state) => {
                state[executionProcess.id] = {
                  executionProcess,
                  entries: patchesWithKey,
                };
              });
              emitEntries(
                displayedExecutionProcesses.current,
                'running',
                false
              );
            },
            onFinished: () => {
              emitEntries(
                displayedExecutionProcesses.current,
                'running',
                false
              );
              closeController();
              resolve();
            },
            onError: (err) => {
              console.warn(
                `Error streaming entries for execution process ${executionProcess.id}`,
                err
              );
              closeController();
              reject(err);
            },
          }
        );
        activeStreamControllersRef.current.set(executionProcess.id, controller);
      });
    },
    [emitEntries]
  );

  const loadInitialEntries =
    useCallback(async (): Promise<ExecutionProcessStateStore> => {
      const localDisplayedExecutionProcesses: ExecutionProcessStateStore = {};

      if (!executionProcesses?.current) return localDisplayedExecutionProcesses;

      const historicProcesses = [...executionProcesses.current]
        .reverse()
        .filter(
          (executionProcess) =>
            executionProcess.status !== ExecutionProcessStatus.running
        );

      for (
        let index = 0;
        index < historicProcesses.length;
        index += HISTORIC_PROCESS_CONCURRENCY
      ) {
        const chunk = historicProcesses.slice(
          index,
          index + HISTORIC_PROCESS_CONCURRENCY
        );
        const chunkEntries = await Promise.all(
          chunk.map(async (executionProcess) => {
            const entries =
              await loadEntriesForHistoricExecutionProcess(executionProcess);
            const entriesWithKey = entries.map((entry, entryIndex) =>
              patchWithKey(entry, executionProcess.id, entryIndex)
            );

            return {
              executionProcess,
              entries: entriesWithKey,
            };
          })
        );

        chunkEntries.forEach(({ executionProcess, entries }) => {
          localDisplayedExecutionProcesses[executionProcess.id] = {
            executionProcess,
            entries,
          };
        });

        const totalEntries = Object.values(localDisplayedExecutionProcesses)
          .flatMap((processState) => processState.entries)
          .length;
        if (totalEntries > MIN_INITIAL_ENTRIES) {
          break;
        }
      }

      return localDisplayedExecutionProcesses;
    }, [executionProcesses]);

  const loadRemainingEntriesInBatches = useCallback(
    async (batchSize: number): Promise<boolean> => {
      if (!executionProcesses?.current) return false;

      const remainingProcesses = [...executionProcesses.current]
        .reverse()
        .filter((executionProcess) => {
          const current = displayedExecutionProcesses.current;
          return (
            !current[executionProcess.id] &&
            executionProcess.status !== ExecutionProcessStatus.running
          );
        });

      if (remainingProcesses.length === 0) {
        return false;
      }

      const chunk = remainingProcesses.slice(0, HISTORIC_PROCESS_CONCURRENCY);
      const chunkEntries = await Promise.all(
        chunk.map(async (executionProcess) => {
          const entries =
            await loadEntriesForHistoricExecutionProcess(executionProcess);
          const entriesWithKey = entries.map((entry, entryIndex) =>
            patchWithKey(entry, executionProcess.id, entryIndex)
          );

          return {
            executionProcess,
            entries: entriesWithKey,
          };
        })
      );

      mergeIntoDisplayed((state) => {
        chunkEntries.forEach(({ executionProcess, entries }) => {
          state[executionProcess.id] = {
            executionProcess,
            entries,
          };
        });
      });

      const totalEntries = Object.values(displayedExecutionProcesses.current)
        .flatMap((processState) => processState.entries)
        .length;

      return totalEntries > batchSize || chunkEntries.length > 0;
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

  // Initial load when attempt changes
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (executionProcessesLoading || loadedInitialEntries.current) {
        return;
      }

      if (executionProcessesRaw.length === 0) {
        loadedInitialEntries.current = true;
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
    idListKey,
    executionProcessesRaw.length,
    executionProcessesLoading,
    loadInitialEntries,
    loadRemainingEntriesInBatches,
    emitEntries,
  ]); // include idListKey so new processes trigger reload

  useEffect(() => {
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
    emitEntries,
    ensureProcessVisible,
    loadRunningAndEmit,
  ]);

  useEffect(() => {
    if (!executionProcessesRaw) return;

    const processesToReload: ExecutionProcess[] = [];

    for (const process of executionProcessesRaw) {
      const previousStatus = previousStatusMapRef.current.get(process.id);
      const currentStatus = process.status;

      if (
        previousStatus === ExecutionProcessStatus.running &&
        currentStatus !== ExecutionProcessStatus.running &&
        displayedExecutionProcesses.current[process.id]
      ) {
        processesToReload.push(process);
      }

      previousStatusMapRef.current.set(process.id, currentStatus);
    }

    if (processesToReload.length === 0) return;

    (async () => {
      let anyUpdated = false;

      for (const process of processesToReload) {
        const entries = await loadEntriesForHistoricExecutionProcess(process);
        if (entries.length === 0) continue;

        const entriesWithKey = entries.map((entry, idx) =>
          patchWithKey(entry, process.id, idx)
        );

        mergeIntoDisplayed((state) => {
          state[process.id] = {
            executionProcess: {
              id: process.id,
              created_at: process.created_at,
              updated_at: process.updated_at,
              executor_action: process.executor_action,
            },
            entries: entriesWithKey,
          };
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

    const removedProcessIds = Object.keys(
      displayedExecutionProcesses.current
    ).filter((id) => !executionProcessesRaw.some((p) => p.id === id));

    if (removedProcessIds.length > 0) {
      mergeIntoDisplayed((state) => {
        removedProcessIds.forEach((id) => {
          delete state[id];
        });
      });
    }
  }, [conversationKey, idListKey, executionProcessesRaw]);

  // Reset state when the active workspace/session conversation changes.
  // Using a ref guard prevents resets when unrelated execution processes update.
  useEffect(() => {
    if (prevConversationKeyRef.current === conversationKey) return;
    prevConversationKeyRef.current = conversationKey;

    closeAllRunningStreams();
    displayedExecutionProcesses.current = {};
    loadedInitialEntries.current = false;
    previousStatusMapRef.current.clear();
    // If there are no execution processes and data is ready, skip the loading state
    const hasNoHistory =
      !executionProcessesLoading && executionProcessesRaw.length === 0;
    emitEntries(displayedExecutionProcesses.current, 'initial', !hasNoHistory);
  }, [
    conversationKey,
    emitEntries,
    executionProcessesLoading,
    executionProcessesRaw.length,
    closeAllRunningStreams,
  ]);

  useEffect(
    () => () => {
      closeAllRunningStreams();
    },
    [closeAllRunningStreams]
  );

  return {};
};
