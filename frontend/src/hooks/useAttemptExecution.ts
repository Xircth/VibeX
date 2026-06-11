import { useMemo, useCallback, useEffect } from 'react';
import { useQueries } from '@tanstack/react-query';
import { attemptsApi, executionProcessesApi } from '@/lib/api';
import {
  useStopToastSuppression,
  useTaskStopping,
} from '@/stores/useTaskDetailsUiStore';
import { useExecutionProcessesContext } from '@/contexts/ExecutionProcessesContext';
import type { AttemptData } from '@/lib/types';
import type { ExecutionProcess } from 'shared/types';
import { useAgentWorkbench } from '@/features/agents/useAgentWorkbench';

export function useAttemptExecution(
  attemptId?: string,
  taskId?: string,
  sessionId?: string | null
) {
  const { isStopping, setIsStopping } = useTaskStopping(taskId || '');
  const { markStopToastSuppressed, clearStopToastSuppression } =
    useStopToastSuppression();
  const { sessions: agentSessions, cancelPrompt } = useAgentWorkbench();
  const agentSession = sessionId ? agentSessions[sessionId] : undefined;
  const activeAgentPromptId = agentSession?.active_prompt_id ?? null;
  const isAgentPromptRunning = Boolean(activeAgentPromptId);

  const {
    executionProcessesVisible: executionProcesses,
    isAttemptRunningVisible: isExecutionProcessRunning,
    isLoading: streamLoading,
  } = useExecutionProcessesContext();

  // Get setup script processes that need detailed info
  const setupProcesses = useMemo(() => {
    if (!executionProcesses.length) return [] as ExecutionProcess[];
    return executionProcesses.filter((p) => p.run_reason === 'setupscript');
  }, [executionProcesses]);

  // Fetch details for setup processes
  const processDetailQueries = useQueries({
    queries: setupProcesses.map((process) => ({
      queryKey: ['processDetails', process.id],
      queryFn: () => executionProcessesApi.getDetails(process.id),
      enabled: !!process.id,
    })),
  });

  // Build attempt data combining processes and details
  const attemptData: AttemptData = useMemo(() => {
    if (!executionProcesses.length) {
      return { processes: [], runningProcessDetails: {} };
    }

    // Build runningProcessDetails from the detail queries
    const runningProcessDetails: Record<string, ExecutionProcess> = {};

    setupProcesses.forEach((process, index) => {
      const detailQuery = processDetailQueries[index];
      if (detailQuery?.data) {
        runningProcessDetails[process.id] = detailQuery.data;
      }
    });

    return {
      processes: executionProcesses,
      runningProcessDetails,
    };
  }, [executionProcesses, setupProcesses, processDetailQueries]);

  const stopExecution = useCallback(async () => {
    if ((!attemptId && !agentSession) || isStopping) return;

    try {
      setIsStopping(true);
      if (attemptId) {
        markStopToastSuppressed(attemptId);
      }

      if (agentSession && activeAgentPromptId) {
        await cancelPrompt({
          connectionId: agentSession.connection_id,
          sessionId: agentSession.id,
          promptId: activeAgentPromptId,
        });
        return;
      }

      if (attemptId) {
        await attemptsApi.stop(attemptId);
      }
    } catch (error) {
      setIsStopping(false);
      if (attemptId) {
        clearStopToastSuppression(attemptId);
      }
      console.error('Failed to stop executions:', error);
      throw error;
    }
  }, [
    activeAgentPromptId,
    agentSession,
    attemptId,
    cancelPrompt,
    clearStopToastSuppression,
    isStopping,
    markStopToastSuppressed,
    setIsStopping,
  ]);

  const clearStopping = useCallback(() => {
    setIsStopping(false);
  }, [setIsStopping]);

  useEffect(() => {
    const isAttemptRunning = isExecutionProcessRunning || isAgentPromptRunning;
    if (isStopping && !isAttemptRunning) {
      setIsStopping(false);
    }
  }, [isAgentPromptRunning, isExecutionProcessRunning, isStopping, setIsStopping]);

  const isLoading =
    streamLoading || processDetailQueries.some((q) => q.isLoading);
  const isFetching =
    streamLoading || processDetailQueries.some((q) => q.isFetching);

  const isAttemptRunning = isExecutionProcessRunning || isAgentPromptRunning;

  return {
    // Data
    processes: executionProcesses,
    attemptData,
    runningProcessDetails: attemptData.runningProcessDetails,

    // Status
    isAttemptRunning,
    isLoading,
    isFetching,

    // Actions
    stopExecution,
    clearStopping,
    isStopping,
  };
}
