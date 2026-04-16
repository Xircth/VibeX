import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Loader } from '@/components/ui/loader';
import { useProject } from '@/contexts/ProjectContext';
import { useTaskAttempts } from '@/hooks/useTaskAttempts';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { paths } from '@/lib/paths';
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
  sessionId,
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
    return <Loader message={'加载会话中...'} size={32} className="py-8" />;
  }

  const effectiveSessionId = sessionId ?? attempt.session?.id;

  if (!effectiveSessionId) {
    return (
      <div className="p-4">
        <Alert>
          <AlertTitle className="flex items-center gap-2">
            <AlertTriangle size="16" />
            {'会话不存在'}
          </AlertTitle>
          <AlertDescription>当前工作区没有可显示的会话。</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <GitOperationsProvider attemptId={attempt.id}>
      <ReviewProvider attemptId={attempt.id}>
        <div className="h-full flex flex-col">
          <NewCard
            className="h-full min-h-0 flex flex-col border-0"
            style={{ backgroundColor: 'hsl(var(--_background))' }}
          >
            <KanbanSessionConversationView
              workspaceId={attempt.id}
              sessionId={effectiveSessionId}
              initialWorkspace={attempt}
              initialSession={attempt.session}
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

function ProjectLegacyAttemptRoute({
  taskId,
  attemptId,
}: {
  taskId: string;
  attemptId: string;
}) {
  const navigate = useNavigate();
  const { projectId } = useProject();
  const { data: attempts = [], isLoading } = useTaskAttempts(taskId, {
    enabled: attemptId === 'latest',
  });

  const latestAttemptId = useMemo(() => {
    if (!attempts.length) return undefined;
    return [...attempts].sort((a, b) => {
      const diff =
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    })[0].id;
  }, [attempts]);

  useEffect(() => {
    if (!projectId) return;
    if (attemptId !== 'latest') return;
    if (isLoading) return;

    if (latestAttemptId) {
      navigate(paths.projectWorkspace(projectId, latestAttemptId), {
        replace: true,
      });
      return;
    }

    navigate(paths.task(projectId, taskId), { replace: true });
  }, [attemptId, isLoading, latestAttemptId, navigate, projectId, taskId]);

  if (attemptId === 'latest') {
    return (
      <Loader message={'解析最新工作区中...'} size={32} className="py-8" />
    );
  }

  return <ProjectWorkspaceSessionRoute workspaceId={attemptId} />;
}

function ProjectLegacyTaskRoute({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const { projectId } = useProject();

  useEffect(() => {
    if (!projectId) return;
    navigate(paths.projectTasks(projectId), { replace: true });
  }, [navigate, projectId, taskId]);

  return <Loader message={'跳转到会话视图中...'} size={32} className="py-8" />;
}

export function ProjectTasks() {
  const { taskId, attemptId, workspaceId, sessionId } = useParams<{
    projectId: string;
    taskId?: string;
    attemptId?: string;
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
            {'错误'}
          </AlertTitle>
          <AlertDescription>
            {projectError.message || 'Failed to load project'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (projectLoading) {
    return <Loader message={'加载项目中...'} size={32} className="py-8" />;
  }

  if (workspaceId) {
    return (
      <ProjectWorkspaceSessionRoute
        workspaceId={workspaceId}
        sessionId={sessionId}
      />
    );
  }

  if (taskId && attemptId) {
    return <ProjectLegacyAttemptRoute taskId={taskId} attemptId={attemptId} />;
  }

  if (!taskId) {
    return <ProjectSessionsHome />;
  }

  return <ProjectLegacyTaskRoute taskId={taskId} />;
}
