import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { TaskWithAttemptStatus, Workspace } from 'shared/types';
import type { SessionStatus, SessionSummary } from '@/lib/api';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import { attemptsApi, sessionsApi } from '@/lib/api';
import type { KanbanSessionPlacement } from '@/lib/kanbanSessionLayout';

export interface KanbanProjectSessionRecord {
  id: string;
  placement: KanbanSessionPlacement;
  workspace: Workspace;
  task: TaskWithAttemptStatus | null;
  taskId: string | null;
  name: string | null;
  status: SessionStatus;
  branch: string;
  workspaceName: string;
  workspaceDisplayLabel: string;
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

function buildDefaultSessionName(
  summary: SessionSummary,
  task: TaskWithAttemptStatus | null
) {
  const manualName = summary.name?.trim();
  if (manualName) {
    return {
      name: manualName,
      source: 'manual' as const,
      prompt: null,
    };
  }

  const firstPrompt = summary.first_prompt?.replace(/\s+/g, ' ').trim() ?? '';
  if (firstPrompt.length > 0) {
    return {
      name: Array.from(firstPrompt).slice(0, 6).join(''),
      source: 'prompt' as const,
      prompt: firstPrompt,
    };
  }

  const taskTitle = task?.title?.trim();
  if (taskTitle) {
    return {
      name: taskTitle,
      source: 'task' as const,
      prompt: null,
    };
  }

  return {
    name: summary.display_name?.trim() || '会话',
    source: 'display' as const,
    prompt: null,
  };
}

function getWorkspaceName(
  workspace: Workspace,
  summary: SessionSummary,
  task: TaskWithAttemptStatus | null
) {
  return workspace.name ?? summary.workspace_name ?? task?.title ?? workspace.branch;
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
        .filter(
          (workspace, index, all) =>
            all.findIndex((candidate) => candidate.id === workspace.id) === index
        )
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
    const nameMetaById = new Map<
      string,
      { source: 'manual' | 'prompt' | 'task' | 'display'; prompt: string | null }
    >();

    const baseSessions = workspaces
      .flatMap((workspace, index) => {
        const summaries = sessionSummaryQueries[index]?.data ?? [];

        return summaries.map((summary) => {
          const taskId = summary.task_id ?? workspace.task_id;
          const task = taskId ? tasksById[taskId] ?? null : null;
          const derivedName = buildDefaultSessionName(summary, task);
          const workspaceName = getWorkspaceName(workspace, summary, task);
          nameMetaById.set(summary.id, {
            source: derivedName.source,
            prompt: derivedName.prompt,
          });

          return {
            id: summary.id,
            placement: {
              sessionId: summary.id,
              workspaceId: workspace.id,
            },
            workspace,
            task,
            taskId,
            name: summary.name,
            status: summary.status,
            branch: summary.workspace_branch,
            workspaceName,
            workspaceDisplayLabel: `${workspaceName} · ${summary.workspace_branch}`,
            executor: summary.executor,
            updatedAt: summary.updated_at,
            createdAt: summary.created_at,
            firstPrompt: summary.first_prompt,
            fullName: derivedName.name,
            shortName: truncateSessionName(derivedName.name),
            taskTitle: task?.title ?? null,
            isCompleted: summary.status === 'done',
            isRunning: summary.is_running,
          };
        });
      })
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime()
      );

    const totalsByBaseName = new Map<string, number>();
    baseSessions.forEach((session) => {
      totalsByBaseName.set(
        session.fullName,
        (totalsByBaseName.get(session.fullName) ?? 0) + 1
      );
    });

    const usedNamesByBaseName = new Map<string, Set<string>>();
    const occurrenceByBaseName = new Map<string, number>();

    return baseSessions.map((session) => {
      const baseName = session.fullName;
      const total = totalsByBaseName.get(baseName) ?? 1;

      if (total <= 1) {
        return session;
      }

      const usedNames = usedNamesByBaseName.get(baseName) ?? new Set<string>();
      usedNamesByBaseName.set(baseName, usedNames);

      let resolvedName = baseName;
      const meta = nameMetaById.get(session.id);
      if (meta?.source === 'prompt' && meta.prompt) {
        const chars = Array.from(meta.prompt);
        const upperBound = Math.min(20, chars.length);
        for (let length = 6; length <= upperBound; length += 1) {
          const candidate = chars.slice(0, length).join('');
          if (!usedNames.has(candidate)) {
            resolvedName = candidate;
            break;
          }
        }
      }

      if (usedNames.has(resolvedName)) {
        const nextOccurrence = (occurrenceByBaseName.get(baseName) ?? 0) + 1;
        occurrenceByBaseName.set(baseName, nextOccurrence);
        resolvedName = `${baseName} #${nextOccurrence}`;
      }

      usedNames.add(resolvedName);

      return {
        ...session,
        fullName: resolvedName,
        shortName: truncateSessionName(resolvedName),
      };
    });
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
