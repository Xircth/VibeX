import { Outlet } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { cn } from '@/lib/utils';

export function RightPanelContent() {
  const activeTab = useLayoutStore((state) => state.activeTab);
  const { visibleRightSession, replaceRightSession } =
    useKanbanSessionContext();
  const showKanbanSession = activeTab === 'kanban' && !!visibleRightSession;

  return (
    <div className="h-full flex overflow-hidden bg-background">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <BranchInfoHeader />
        <div
          className={cn(
            'flex-1 min-h-0 overflow-hidden',
            showKanbanSession && 'hidden'
          )}
        >
          <Outlet />
        </div>
        {showKanbanSession && visibleRightSession ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <KanbanSessionConversationView
              workspaceId={visibleRightSession.workspaceId}
              sessionId={visibleRightSession.sessionId}
              interactive={true}
              showSessionSelector={true}
              onSessionCreated={replaceRightSession}
              className="h-full"
            />
          </div>
        ) : null}
      </div>
      <RightPanelSidebar />
    </div>
  );
}
