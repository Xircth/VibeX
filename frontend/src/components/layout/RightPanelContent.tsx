import { Outlet, useParams } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useProject } from '@/contexts/ProjectContext';
import { openTaskForm } from '@/lib/openTaskForm';
import { Plus } from 'lucide-react';

export function RightPanelContent() {
  const { taskId, attemptId } = useParams<{
    taskId?: string;
    attemptId?: string;
  }>();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const routeTab = taskId && attemptId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const { visibleRightSession, replaceRightSession } =
    useKanbanSessionContext();
  const { projectId } = useProject();
  const showRightSession = !!visibleRightSession;

  const handleCreateTask = () => {
    if (projectId) {
      openTaskForm({ mode: 'create', projectId });
    }
  };

  return (
    <div className="h-full flex overflow-hidden bg-background">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <BranchInfoHeader />
        {showRightSession && visibleRightSession ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <KanbanSessionConversationView
              workspaceId={visibleRightSession.workspaceId}
              sessionId={visibleRightSession.sessionId}
              interactive={true}
              showSessionSelector={true}
              onSessionCreated={replaceRightSession}
              onSessionSelected={replaceRightSession}
              className="h-full"
            />
          </div>
        ) : effectiveActiveTab === 'workspace' && taskId ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Outlet />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">
              创建新任务开始工作
            </p>
            <button
              onClick={handleCreateTask}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 transition-opacity"
            >
              <Plus className="h-3.5 w-3.5" />
              新建任务
            </button>
          </div>
        )}
      </div>
      {effectiveActiveTab === 'workspace' ? <RightPanelSidebar /> : null}
    </div>
  );
}
