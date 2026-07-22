import { useCallback, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { IDockviewPanelProps } from 'dockview-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionHubListItem } from '@/components/kanban/session-hub/SessionHubListItem';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useKanbanProjectSessions } from '@/hooks/useKanbanProjectSessions';
import { useTaskAttempt } from '@/hooks/useTaskAttempt';
import { useNavigateWithSearch } from '@/hooks/useNavigateWithSearch';
import { paths } from '@/lib/paths';
import {
  WORKSPACE_SESSION_MARKER_CLASSES,
  workspaceSessionMarkerTone,
} from './workspaceSessionMarkers';

function WorkspaceSessionListPanel(_props: IDockviewPanelProps) {
  const { t } = useTranslation(['panels', 'common']);
  const navigate = useNavigateWithSearch();
  const { projectId } = useProject();
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const { activeWorktreeId, setActiveWorktree } = useWorktree();
  const { visibleRightSession, replaceRightSession } =
    useKanbanSessionContext();
  const { data: activeWorkspace } = useTaskAttempt(
    activeWorktreeId ?? undefined
  );
  const { sessions, isLoading } = useKanbanProjectSessions(projectId);
  const activeSessionId =
    routeSessionId ?? visibleRightSession?.sessionId ?? null;
  const activeBranch = activeWorkspace?.branch ?? null;
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status !== 'archived'),
    [sessions]
  );

  const openSession = useCallback(
    (session: (typeof activeSessions)[number]) => {
      replaceRightSession(session.placement);
      setActiveWorktree(session.workspace.id, session.taskId);
      if (projectId) {
        navigate(
          paths.projectSession(projectId, session.workspace.id, session.id)
        );
      }
    },
    [navigate, projectId, replaceRightSession, setActiveWorktree]
  );

  return (
    <TooltipProvider delayDuration={120}>
      <section
        className="flex h-full min-h-0 flex-col bg-background"
        aria-label={t('workspaceSessionList.title')}
      >
        <header className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {t('workspaceSessionList.title')}
          </h2>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {activeSessions.length}
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('workspaceSessionList.loading')}
            </div>
          ) : activeSessions.length === 0 ? (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-muted-foreground">
              {t('workspaceSessionList.empty')}
            </div>
          ) : (
            <div className="space-y-1">
              {activeSessions.map((session) => {
                const tone = workspaceSessionMarkerTone({
                  sessionId: session.id,
                  workspaceId: session.workspace.id,
                  branch: session.branch,
                  activeSessionId,
                  activeWorkspaceId: activeWorktreeId,
                  activeBranch,
                });
                return (
                  <SessionHubListItem
                    key={session.id}
                    session={session}
                    marker={{ bar: WORKSPACE_SESSION_MARKER_CLASSES[tone] }}
                    isDeleteMode={false}
                    isSelected={false}
                    onClick={() => openSession(session)}
                    onToggleSelect={() => undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

export default WorkspaceSessionListPanel;
