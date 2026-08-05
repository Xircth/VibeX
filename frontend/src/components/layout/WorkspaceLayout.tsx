import { useEffect, type ReactNode } from 'react';
import { useProject } from '@/contexts/ProjectContext';
import { WorktreeProvider } from '@/contexts/WorktreeContext';
import {
  KanbanSessionProvider,
  useKanbanSessionContext,
} from '@/contexts/KanbanSessionContext';
import { PanelActionsProvider } from '@/contexts/PanelActionsContext';
import { TerminalProvider } from '@/contexts/TerminalContext';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import { IDELayout } from '@/components/layout/IDELayout';
import { KanbanSessionConversationPlacementProvider } from '@/components/kanban/KanbanSessionConversationView';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { attemptsApi } from '@/lib/api';

interface WorkspaceLayoutProps {
  /** Content for the right fixed panel (AI Chat area) */
  rightPanelContent?: ReactNode;
  /** Content for the toolbar area */
  toolbarContent?: ReactNode;
}

function PendingProjectFocusBridge() {
  const { projectId } = useProject();
  const { activateExecutionSession, goToBoard, isLayoutHydrated } =
    useKanbanSessionContext();
  const consumeProjectFocus = useWindowProjectsStore(
    (state) => state.consumeProjectFocus
  );
  const pendingProjectFocus = useWindowProjectsStore((state) =>
    projectId ? state.focusRequests[projectId] : undefined
  );
  const setActiveTab = useLayoutStore((state) => state.setActiveTab);
  const setRightPanelVisible = useLayoutStore(
    (state) => state.setRightPanelVisible
  );

  useEffect(() => {
    if (!projectId || !pendingProjectFocus || !isLayoutHydrated) {
      return;
    }

    const focusRequest = consumeProjectFocus(projectId);
    if (!focusRequest) {
      return;
    }

    setActiveTab('kanban');
    setRightPanelVisible(true);
    goToBoard();
    activateExecutionSession({
      workspaceId: focusRequest.workspaceId,
      sessionId: focusRequest.sessionId,
    });

    void attemptsApi.markSeen(focusRequest.workspaceId).catch(() => {
      // Ignore mark-seen failures for toast navigation.
    });
  }, [
    consumeProjectFocus,
    goToBoard,
    isLayoutHydrated,
    pendingProjectFocus,
    projectId,
    activateExecutionSession,
    setActiveTab,
    setRightPanelVisible,
  ]);

  return null;
}

/**
 * WorkspaceLayout wraps IDELayout with all necessary context providers.
 * This is the top-level layout component for the IDE workspace.
 */
export function WorkspaceLayout({
  rightPanelContent,
  toolbarContent,
}: WorkspaceLayoutProps) {
  return (
    <WorktreeProvider>
      <KanbanSessionProvider>
        <PendingProjectFocusBridge />
        <ReviewProvider>
          <TerminalProvider>
            <PanelActionsProvider>
              <KanbanSessionConversationPlacementProvider>
                <IDELayout
                  rightPanelContent={rightPanelContent}
                  toolbarContent={toolbarContent}
                />
              </KanbanSessionConversationPlacementProvider>
            </PanelActionsProvider>
          </TerminalProvider>
        </ReviewProvider>
      </KanbanSessionProvider>
    </WorktreeProvider>
  );
}
