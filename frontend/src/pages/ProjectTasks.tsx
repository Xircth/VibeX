import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Plus } from 'lucide-react';
import { openTaskForm } from '@/lib/openTaskForm';
import { Loader } from '@/components/ui/loader';
import { useProject } from '@/contexts/ProjectContext';
import { useTaskAttempts } from '@/hooks/useTaskAttempts';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { paths } from '@/lib/paths';
import { useClickedElements } from '@/contexts/ClickedElementsProvider';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import {
  GitOperationsProvider,
  useGitOperationsError,
} from '@/contexts/GitOperationsContext';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import TaskAttemptPanel from '@/components/panels/TaskAttemptPanel';
import TaskPanel from '@/components/panels/TaskPanel';
import { NewCard } from '@/components/ui/new-card';

function GitErrorBanner() {
  const { error: gitError } = useGitOperationsError();

  if (!gitError) return null;

  return (
    <div className="mx-4 mt-4 p-3 border border-destructive rounded">
      <div className="text-destructive text-sm">{gitError}</div>
    </div>
  );
}

export function ProjectTasks() {
  const { taskId, attemptId } = useParams<{
    projectId: string;
    taskId?: string;
    attemptId?: string;
  }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setActiveTab = useLayoutStore((state) => state.setActiveTab);

  const {
    projectId,
    isLoading: projectLoading,
    error: projectError,
  } = useProject();

  const {
    tasks,
    tasksById,
    isLoading,
    error: streamError,
  } = useProjectTasks(projectId || '');

  const selectedTask = useMemo(
    () => (taskId ? (tasksById[taskId] ?? null) : null),
    [taskId, tasksById]
  );

  const isLatest = attemptId === 'latest';
  const { data: attempts = [], isLoading: isAttemptsLoading } = useTaskAttempts(
    taskId,
    {
      enabled: !!taskId && isLatest,
    }
  );

  const latestAttemptId = useMemo(() => {
    if (!attempts?.length) return undefined;
    return [...attempts].sort((a, b) => {
      const diff =
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    })[0].id;
  }, [attempts]);

  const navigateWithSearch = useCallback(
    (pathname: string, options?: { replace?: boolean }) => {
      const search = searchParams.toString();
      navigate({ pathname, search: search ? `?${search}` : '' }, options);
    },
    [navigate, searchParams]
  );

  useEffect(() => {
    if (!projectId || !taskId || !attemptId) return;
    setActiveTab('workspace');
  }, [attemptId, projectId, setActiveTab, taskId]);

  // Resolve "latest" attempt to the actual latest attempt ID
  useEffect(() => {
    if (!projectId || !taskId) return;
    if (!isLatest) return;
    if (isAttemptsLoading) return;

    if (!latestAttemptId) {
      navigateWithSearch(paths.task(projectId, taskId), { replace: true });
      return;
    }

    navigateWithSearch(paths.attempt(projectId, taskId, latestAttemptId), {
      replace: true,
    });
  }, [
    projectId,
    taskId,
    isLatest,
    isAttemptsLoading,
    latestAttemptId,
    navigate,
    navigateWithSearch,
  ]);

  // Redirect away if selected task doesn't exist
  useEffect(() => {
    if (!projectId || !taskId || isLoading) return;
    if (selectedTask === null) {
      navigate(`/local-projects/${projectId}/tasks`, { replace: true });
    }
  }, [projectId, taskId, isLoading, selectedTask, navigate]);

  const effectiveAttemptId = attemptId === 'latest' ? undefined : attemptId;
  const isTaskView = !!taskId && !effectiveAttemptId;
  const { data: attempt } = useTaskAttemptWithSession(effectiveAttemptId);

  // Sync attempt info to the shared ClickedElements context so that
  // dockview panels (e.g. PreviewPanel) and this page share the same state.
  const { syncAttempt } = useClickedElements();
  useEffect(() => {
    syncAttempt(attempt?.id, attempt?.container_ref ?? undefined);
  }, [attempt?.id, attempt?.container_ref, syncAttempt]);

  const isInitialTasksLoad = isLoading && tasks.length === 0;

  // Must be declared before any conditional returns to satisfy React Hooks rules
  const handleCreateTask = useCallback(() => {
    if (projectId) {
      openTaskForm({ mode: 'create', projectId });
    }
  }, [projectId]);

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

  if (projectLoading && isInitialTasksLoad) {
    return <Loader message={'加载任务中...'} size={32} className="py-8" />;
  }

  const attemptContent = selectedTask ? (
    <NewCard
      className="h-full min-h-0 flex flex-col border-0"
      style={{ backgroundColor: 'hsl(var(--_background))' }}
    >
      {isTaskView ? (
        <TaskPanel task={selectedTask} />
      ) : (
        <TaskAttemptPanel attempt={attempt} task={selectedTask}>
          {({ logs, followUp }) => (
            <>
              <GitErrorBanner />
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{logs}</div>
                {followUp}
              </div>
            </>
          )}
        </TaskAttemptPanel>
      )}
    </NewCard>
  ) : (
    <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
      <p className="text-sm mb-3">从看板中选择一个任务，或创建新任务</p>
      <button
        onClick={handleCreateTask}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 transition-opacity"
      >
        <Plus className="h-3.5 w-3.5" />
        新建任务
      </button>
    </div>
  );

  return (
    <GitOperationsProvider attemptId={attempt?.id}>
      <ReviewProvider attemptId={attempt?.id}>
        <div className="h-full flex flex-col">
          {streamError && (
            <Alert className="w-full z-30 xl:sticky xl:top-0">
              <AlertTitle className="flex items-center gap-2">
                <AlertTriangle size="16" />
                {'重新连接中'}
              </AlertTitle>
              <AlertDescription>{streamError}</AlertDescription>
            </Alert>
          )}
          <div className="flex-1 min-h-0">{attemptContent}</div>
        </div>
      </ReviewProvider>
    </GitOperationsProvider>
  );
}
