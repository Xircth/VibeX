import { Outlet, useParams } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { cn } from '@/lib/utils';

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
  const showRightSession = !!visibleRightSession;

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
        ) : (
          <div
            className={cn(
              'flex-1 min-h-0 overflow-hidden',
              effectiveActiveTab === 'kanban' && 'hidden'
            )}
          >
            <Outlet />
          </div>
        )}
      </div>
      {effectiveActiveTab === 'workspace' ? <RightPanelSidebar /> : null}
    </div>
  );
}
