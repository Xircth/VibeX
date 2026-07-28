import { useEffect, useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Session, TaskWithAttemptStatus, Workspace } from 'shared/types';
import type { SessionStatus, SessionSummary } from '@/lib/api';
import type { KanbanSessionPlacement } from '@/lib/kanbanSessionLayout';
import { sessionsApi } from '@/lib/api';
import { dateTimestamp } from '@/utils/date';
import { useProjectWorkspacesStream } from './useProjectWorkspacesStream';

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
  isErrored: boolean;
}

function truncateSessionName(name: string, length = 7) {
  const chars = Array.from(name);
  if (chars.length <= length) return name;
  return chars.slice(0, length).join('');
}

const SESSION_PLACEHOLDERS = new Set([
  'Session',
  '会话',
  'New session',
  'New Session',
  '新会话',
]);

function isSessionPlaceholder(value: string) {
  return (
    SESSION_PLACEHOLDERS.has(value) ||
    /^新会话_[a-z0-9]+$/i.test(value) ||
    /^new session_[a-z0-9]+$/i.test(value) ||
    /^新会话[a-z0-9]+$/i.test(value) ||
    /^new session[a-z0-9]+$/i.test(value)
  );
}

function fallbackSessionName(summary: SessionSummary, label: string) {
  const displayName = summary.display_name?.trim();
  if (
    displayName &&
    (/^新会话\d+$/u.test(displayName) || /^new session\d+$/iu.test(displayName))
  ) {
    return displayName;
  }

  return `${label}1`;
}

export function buildDefaultSessionName(
  summary: SessionSummary,
  t: TFunction<['app', 'common']>
) {
  const manualName = summary.name?.trim();
  if (manualName) {
    return {
      name: manualName,
      source: 'manual' as const,
      prompt: null,
    };
  }

  const firstPrompt = summary.first_prompt?.replace(/\s+/g, ' ').trim();
  const displayName = summary.display_name?.replace(/\s+/g, ' ').trim();
  const promptName =
    firstPrompt ||
    (displayName && !isSessionPlaceholder(displayName) ? displayName : '');

  if (promptName.length > 0) {
    return {
      name: Array.from(promptName).slice(0, 8).join(''),
      source: 'prompt' as const,
      prompt: promptName,
    };
  }

  return {
    name: fallbackSessionName(summary, t('kanbanSessions.sessionFallback')),
    source: 'fallback' as const,
    prompt: null,
  };
}

function getWorkspaceName(workspace: Workspace, summary: SessionSummary) {
  return workspace.name ?? summary.workspace_name ?? workspace.branch;
}

export function useKanbanProjectSessions(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(['app', 'common']);
  const {
    workspaces,
    workspacesWithStatus,
    isLoading: isWorkspacesLoading,
  } = useProjectWorkspacesStream(projectId ?? '');

  const sessionSummaryQueries = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: ['workspaceSessions', workspace.id, 'summaries'],
      queryFn: () => sessionsApi.getSummariesByWorkspace(workspace.id),
      enabled: !!workspace.id,
    })),
  });

  const sessionSummaries = useMemo(
    () => sessionSummaryQueries.flatMap((query) => query.data ?? []),
    [sessionSummaryQueries]
  );

  useEffect(() => {
    workspaces.forEach((workspace) => {
      queryClient.setQueryData<Workspace>(
        ['taskAttempt', workspace.id],
        (current) => current ?? workspace
      );
    });

    sessionSummaries.forEach((summary) => {
      const session: Session = {
        id: summary.id,
        workspace_id: summary.workspace_id,
        task_id: summary.task_id,
        name: summary.name,
        initial_prompt: summary.first_prompt,
        status: summary.status,
        executor: summary.executor,
        external_session_id: null,
        agent_type: null,
        parent_session_id: null,
        parent_tool_use_id: null,
        delegation_call_id: null,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
      };

      queryClient.setQueryData<Session>(['session', summary.id], (current) => {
        if (!current) {
          return session;
        }
        return {
          ...session,
          ...current,
        };
      });
    });
  }, [queryClient, sessionSummaries, workspaces]);

  const sessions = useMemo<KanbanProjectSessionRecord[]>(() => {
    const nameMetaById = new Map<
      string,
      { source: 'manual' | 'prompt' | 'fallback'; prompt: string | null }
    >();
    const workspaceStatusById = new Map(
      workspacesWithStatus.map((workspace) => [
        workspace.id,
        workspace.is_errored,
      ])
    );

    const baseSessions = workspaces
      .flatMap((workspace, index) => {
        const summaries = sessionSummaryQueries[index]?.data ?? [];

        return summaries.map((summary) => {
          const derivedName = buildDefaultSessionName(summary, t);
          const workspaceName = getWorkspaceName(workspace, summary);
          const isErrored = workspaceStatusById.get(workspace.id) ?? false;
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
            task: null,
            taskId: summary.task_id ?? workspace.task_id ?? null,
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
            taskTitle: null,
            isCompleted: summary.status === 'done',
            isRunning: summary.is_running,
            isErrored,
          };
        });
      })
      .sort(
        (left, right) =>
          dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt)
      );

    const getDuplicateKey = (session: KanbanProjectSessionRecord) =>
      `${session.status === 'archived' ? 'archived' : 'active'}:${
        session.fullName
      }`;

    const totalsByBaseName = new Map<string, number>();
    baseSessions.forEach((session) => {
      const duplicateKey = getDuplicateKey(session);
      totalsByBaseName.set(
        duplicateKey,
        (totalsByBaseName.get(duplicateKey) ?? 0) + 1
      );
    });

    const usedNamesByBaseName = new Map<string, Set<string>>();
    const occurrenceByBaseName = new Map<string, number>();
    const fallbackOccurrences = new Map<string, number>();

    return baseSessions.map((session) => {
      const baseName = session.fullName;
      const duplicateKey = getDuplicateKey(session);
      const total = totalsByBaseName.get(duplicateKey) ?? 1;
      const meta = nameMetaById.get(session.id);

      if (meta?.source === 'fallback') {
        const statusKey = session.status === 'archived' ? 'archived' : 'active';
        const occurrence = (fallbackOccurrences.get(statusKey) ?? 0) + 1;
        fallbackOccurrences.set(statusKey, occurrence);
        const resolvedName = `${t('kanbanSessions.sessionFallback')}${occurrence}`;
        return {
          ...session,
          fullName: resolvedName,
          shortName: truncateSessionName(resolvedName),
        };
      }

      if (total <= 1) {
        return session;
      }

      const usedNames =
        usedNamesByBaseName.get(duplicateKey) ?? new Set<string>();
      usedNamesByBaseName.set(duplicateKey, usedNames);

      let resolvedName = baseName;
      if (meta?.source === 'prompt' && meta.prompt) {
        const chars = Array.from(meta.prompt);
        const upperBound = Math.min(32, chars.length);
        for (let length = 8; length <= upperBound; length += 1) {
          const candidate = chars.slice(0, length).join('');
          if (!usedNames.has(candidate)) {
            resolvedName = candidate;
            break;
          }
        }
      }

      if (usedNames.has(resolvedName)) {
        const nextOccurrence =
          (occurrenceByBaseName.get(duplicateKey) ?? 0) + 1;
        occurrenceByBaseName.set(duplicateKey, nextOccurrence);
        resolvedName = `${resolvedName}_${nextOccurrence}`;
      }

      usedNames.add(resolvedName);

      return {
        ...session,
        fullName: resolvedName,
        shortName: truncateSessionName(resolvedName),
      };
    });
  }, [sessionSummaryQueries, t, workspaces, workspacesWithStatus]);

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

  return {
    sessions,
    sessionsById,
    workspaces,
    workspacesWithStatus,
    isLoading:
      isWorkspacesLoading ||
      sessionSummaryQueries.some((query) => query.isLoading),
  };
}
