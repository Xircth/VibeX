import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Loader } from '@/components/ui/loader';
import { useProject } from '@/contexts/ProjectContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useClickedElements } from '@/contexts/ClickedElementsProvider';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import { GitOperationsProvider } from '@/contexts/GitOperationsContext';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { NewCard } from '@/components/ui/new-card';
import { KanbanBoard } from '@/components/panels/DockviewKanbanPanel';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';

function ProjectSessionsHome() {
  return <KanbanBoard />;
}

function ProjectWorkspaceSessionRoute({
  workspaceId,
  sessionId: routeSessionId,
}: {
  workspaceId: string;
  sessionId?: string;
}) {
  const { data: attempt, isLoading: isLoadingAttempt } =
    useTaskAttemptWithSession(workspaceId);
  const { syncAttempt } = useClickedElements();

  useEffect(() => {
    syncAttempt(attempt?.id, attempt?.container_ref ?? undefined);
  }, [attempt?.container_ref, attempt?.id, syncAttempt]);

  if (isLoadingAttempt || !attempt) {
    return <Loader message="加载会话中..." size={32} className="py-8" />;
  }

  const matchedInitialSession =
    routeSessionId && attempt.session?.id === routeSessionId
      ? attempt.session
      : undefined;

  return (
    <GitOperationsProvider attemptId={attempt.id}>
      <ReviewProvider attemptId={attempt.id}>
        <div className="flex h-full flex-col">
          <NewCard
            className="flex h-full min-h-0 flex-col border-0"
            style={{ backgroundColor: 'hsl(var(--_background))' }}
          >
            <KanbanSessionConversationView
              workspaceId={attempt.id}
              sessionId={routeSessionId}
              initialWorkspace={attempt}
              initialSession={matchedInitialSession}
              interactive={true}
              showSessionSelector={true}
              className="h-full"
            />
          </NewCard>
        </div>
      </ReviewProvider>
    </GitOperationsProvider>
  );
}

export function ProjectTasks() {
  const { workspaceId, sessionId } = useParams<{
    projectId: string;
    workspaceId?: string;
    sessionId?: string;
  }>();
  const navigate = useNavigate();
  const {
    projectId,
    project,
    isLoading: projectLoading,
    error: projectError,
  } = useProject();

  useEffect(() => {
    if (!projectLoading && !project && projectId) {
      navigate('/local-projects', { replace: true });
    }
  }, [navigate, project, projectId, projectLoading]);

  if (projectError) {
    return (
      <div className="p-4">
        <Alert>
          <AlertTitle className="flex items-center gap-2">
            <AlertTriangle size="16" />
            错误
          </AlertTitle>
          <AlertDescription>
            {projectError.message || 'Failed to load project'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (projectLoading) {
    return <Loader message="加载项目中..." size={32} className="py-8" />;
  }

  if (workspaceId) {
    return (
      <ProjectWorkspaceSessionRoute
        workspaceId={workspaceId}
        sessionId={sessionId}
      />
    );
  }

  return <ProjectSessionsHome />;
}
