import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type {
  TaskStatus,
  TaskWithAttemptStatus,
  Workspace,
} from 'shared/types';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import { attemptsApi, sessionsApi } from '@/lib/api';
import type { KanbanSessionPlacement } from '@/lib/kanbanSessionLayout';
import type { SessionSummary } from '@/lib/api';

export interface KanbanProjectSessionRecord {
  id: string;
  placement: KanbanSessionPlacement;
  workspace: Workspace;
  task: TaskWithAttemptStatus | null;
  taskStatus: TaskStatus | null;
  branch: string;
  executor: string | null;
  updatedAt: string;
  createdAt: string;
  firstPrompt: string | null;
  fullName: string;
  shortName: string;
  taskTitle: string | null;
  isCompleted: boolean;
  isRunning: boolean;
}

function truncateSessionName(name: string, length = 7) {
  const chars = Array.from(name);
  if (chars.length <= length) return name;
  return chars.slice(0, length).join('');
}

function getSessionDisplayName(summary: SessionSummary) {
  const prompt = summary.first_prompt?.trim();
  return prompt && prompt.length > 0 ? prompt : '新会话';
}

export function useKanbanProjectSessions(projectId: string | undefined) {
  const {
    tasks,
    tasksById,
    isLoading: isTasksLoading,
  } = useProjectTasks(projectId ?? '');

  const taskIds = useMemo(() => tasks.map((task) => task.id).sort(), [tasks]);

  const { data: workspaces = [], isLoading: isWorkspacesLoading } = useQuery<
    Workspace[]
  >({
    queryKey: ['kanbanProjectWorkspaces', projectId, taskIds],
    queryFn: async () => {
      if (!taskIds.length) return [];
      const results = await Promise.all(
        taskIds.map((taskId) => attemptsApi.getAll(taskId))
      );
      return results
        .flat()
        .filter((workspace) => !workspace.archived)
        .sort(
          (left, right) =>
            new Date(right.updated_at).getTime() -
            new Date(left.updated_at).getTime()
        );
    },
    enabled: !!projectId,
  });

  const sessionSummaryQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: ['workspaceSessions', workspace.id, 'summaries'],
      queryFn: () => sessionsApi.getSummariesByWorkspace(workspace.id),
      enabled: !!workspace.id,
    })),
  });

  const sessions = useMemo<KanbanProjectSessionRecord[]>(() => {
    return workspaces
      .flatMap((workspace, index) => {
        const task = tasksById[workspace.task_id] ?? null;
        const summaries = sessionSummaryQueries[index]?.data ?? [];

        return summaries.map((summary) => {
          const fullName = getSessionDisplayName(summary);
          const taskStatus = task?.status ?? null;

          return {
            id: summary.id,
            placement: {
              sessionId: summary.id,
              workspaceId: workspace.id,
            },
            workspace,
            task,
            taskStatus,
            branch: workspace.branch,
            executor: summary.executor,
            updatedAt: summary.updated_at,
            createdAt: summary.created_at,
            firstPrompt: summary.first_prompt,
            fullName,
            shortName: truncateSessionName(fullName),
            taskTitle: task?.title ?? null,
            isCompleted: taskStatus === 'done' || taskStatus === 'cancelled',
            isRunning: summary.is_running,
          };
        });
      })
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime()
      );
  }, [sessionSummaryQueries, tasksById, workspaces]);

  const sessionsById = useMemo(
    () =>
      sessions.reduce<Record<string, KanbanProjectSessionRecord>>(
        (accumulator, session) => {
          accumulator[session.id] = session;
          return accumulator;
        },
        {}
      ),
    [sessions]
  );

  const isLoading =
    isTasksLoading ||
    isWorkspacesLoading ||
    sessionSummaryQueries.some((query) => query.isLoading);

  return {
    sessions,
    sessionsById,
    workspaces,
    isLoading,
  };
}
