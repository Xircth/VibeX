import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useProject } from '@/contexts/ProjectContext';
import { paths } from '@/lib/paths';
import { Loader2, Plus } from 'lucide-react';

export function RightPanelContent() {
  const navigate = useNavigate();
  const {
    projectId: routeProjectId,
    taskId,
    attemptId,
    workspaceId,
    sessionId,
  } = useParams<{
    projectId?: string;
    taskId?: string;
    attemptId?: string;
    workspaceId?: string;
    sessionId?: string;
  }>();
  const activeTab = useLayoutStore((state) => state.activeTab);
  const routeTab =
    (taskId && attemptId) || workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const { visibleRightSession, replaceRightSession, isRightSessionPending } =
    useKanbanSessionContext();
  const { projectId } = useProject();
  const effectiveProjectId = projectId ?? routeProjectId;
  const showRightSession = !!visibleRightSession;

  const handleCreateSession = () => {
    if (effectiveProjectId) {
      navigate(`${paths.projectTasks(effectiveProjectId)}?createSession=1`);
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
        ) : effectiveActiveTab === 'workspace' && (taskId || workspaceId) ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Outlet />
          </div>
        ) : isRightSessionPending ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Loading session...</p>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-muted-foreground">创建新会话开始工作</p>
            <button
              onClick={handleCreateSession}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 transition-opacity"
            >
              <Plus className="h-3.5 w-3.5" />
              新建会话
            </button>
          </div>
        )}
      </div>
      {effectiveActiveTab === 'workspace' ? <RightPanelSidebar /> : null}
    </div>
  );
}
