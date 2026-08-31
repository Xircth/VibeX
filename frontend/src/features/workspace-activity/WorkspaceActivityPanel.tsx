import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, AlertTriangle, Flame, Terminal } from 'lucide-react';
import { conversationApi } from '@/features/conversation/conversationApi';
import { useKanbanProjectSessions } from '@/hooks/useKanbanProjectSessions';
import { useExecutionProcesses } from '@/hooks/useExecutionProcesses';
import { useProject } from '@/contexts/ProjectContext';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { SessionFlameGraph } from './SessionFlameGraph';
import {
  activityNoticesFromRows,
  activitySpansFromTimeline,
} from './workspaceActivityModel';

export function WorkspaceActivityPanel({
  workspaceId,
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const { projectId } = useProject();
  const { sessions } = useKanbanProjectSessions(projectId);
  const { executionProcesses } = useExecutionProcesses(sessionId ?? '', {
    showSoftDeleted: true,
  });
  const terminalSessions = useTerminalStore((state) =>
    workspaceId ? (state.sessionsByWorkspace[workspaceId] ?? []) : []
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

  const workspaceSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.status !== 'archived' &&
          (!workspaceId || session.workspace.id === workspaceId)
      ),
    [sessions, workspaceId]
  );

  const backgroundTasks = useMemo(() => {
    const terminals = terminalSessions
      .filter((session) => session.source === 'acp')
      .map((session) => ({
        id: session.tabId,
        label: session.title,
        detail: t('workspaceActivity.running'),
      }));
    const processes = executionProcesses
      .filter(
        (process) =>
          process.run_reason === 'devserver' ||
          process.run_reason === 'setupscript' ||
          process.run_reason === 'cleanupscript' ||
          process.run_reason === 'archivescript'
      )
      .map((process) => ({
        id: process.id,
        label: process.run_reason,
        detail: process.status,
      }));
    return [...terminals, ...processes];
  }, [executionProcesses, t, terminalSessions]);

  const selected = workspaceSessions.find(
    (session) => session.id === selectedSessionId
  );
  const { data: detail } = useQuery({
    queryKey: ['workspace-activity-detail', selectedSessionId],
    queryFn: () =>
      selectedSessionId
        ? conversationApi.detail(selectedSessionId)
        : Promise.resolve(null),
    enabled: Boolean(selectedSessionId),
  });

  const spans = useMemo(
    () => activitySpansFromTimeline(detail?.timeline),
    [detail]
  );
  const notices = useMemo(() => {
    const fromSessions = workspaceSessions
      .filter((session) => session.isErrored)
      .map((session) => session.fullName);
    const fromDetail = activityNoticesFromRows(detail?.timeline.rows ?? []);
    const fromProcesses = executionProcesses
      .filter(
        (process) => process.status === 'failed' || process.status === 'killed'
      )
      .map((process) => process.run_reason);
    return [...fromSessions, ...fromDetail, ...fromProcesses];
  }, [detail, executionProcesses, workspaceSessions]);

  if (selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          className="flex items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setSelectedSessionId(null)}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('workspaceActivity.backToList')}
        </button>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <h3 className="mb-3 text-sm font-medium">{selected.fullName}</h3>
          {spans.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('workspaceActivity.noSpans')}
            </p>
          ) : (
            <SessionFlameGraph spans={spans} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <section className="mb-6">
        <h3 className="mb-2 text-sm font-medium text-foreground">
          {t('workspaceActivity.sessions')}
        </h3>
        {workspaceSessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('workspaceActivity.emptySessions')}
          </p>
        ) : (
          <ul className="space-y-1">
            {workspaceSessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60"
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <Flame className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {session.fullName}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t('workspaceActivity.openFlame')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h3 className="mb-2 text-sm font-medium text-foreground">
          {t('workspaceActivity.background')}
        </h3>
        {backgroundTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('workspaceActivity.emptyBackground')}
          </p>
        ) : (
          <ul className="space-y-1">
            {backgroundTasks.map((task) => (
              <li
                key={task.id}
                className="flex items-center gap-2 rounded-md px-2 py-2 text-sm"
              >
                <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{task.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {task.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-foreground">
          {t('workspaceActivity.notices')}
        </h3>
        {notices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('workspaceActivity.emptyNotices')}
          </p>
        ) : (
          <ul className="space-y-1">
            {notices.map((notice) => (
              <li
                key={notice}
                className="flex items-start gap-2 rounded-md px-2 py-2 text-sm"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-destructive" />
                <span>{notice}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
