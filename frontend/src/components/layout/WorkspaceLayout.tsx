import { useEffect, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { resolveFocusDispatch } from '@/lib/projectFocusRouting';
import { requestCanvasReveal } from '@/lib/canvasSessionReveal';

interface WorkspaceLayoutProps {
  /** Content for the right fixed panel (AI Chat area) */
  rightPanelContent?: ReactNode;
  /** Content for the toolbar area */
  toolbarContent?: ReactNode;
}

function PendingProjectFocusBridge() {
  const { projectId } = useProject();
  const navigate = useNavigate();
  const {
    workspaceId: routeWorkspaceId,
    sessionId: routeSessionId,
  } = useParams();
  const { activateExecutionSession, panelView, isLayoutHydrated } =
    useKanbanSessionContext();
  const consumeProjectFocus = useWindowProjectsStore(
    (state) => state.consumeProjectFocus
  );
  const pendingProjectFocus = useWindowProjectsStore((state) =>
    projectId ? state.focusRequests[projectId] : undefined
  );
  const activeTab = useLayoutStore((state) => state.activeTab);
  const setRightPanelVisible = useLayoutStore(
    (state) => state.setRightPanelVisible
  );
  const setKanbanSessionVisible = useLayoutStore(
    (state) => state.setKanbanSessionVisible
  );
  const boardStyle = useKanbanBoardStyle();

  useEffect(() => {
    if (!projectId || !pendingProjectFocus || !isLayoutHydrated) {
      return;
    }

    const focusRequest = consumeProjectFocus(projectId);
    if (!focusRequest) {
      return;
    }

    // A deep workspace/session route forces the workspace surface (mirroring
    // IDELayout's `effectiveActiveTab`); otherwise the kanban/workspace surface
    // is whatever tab the user is on. Never switch the tab itself — the session
    // is revealed where the user already is.
    const surface =
      routeWorkspaceId || routeSessionId ? 'workspace' : activeTab;
    const isCanvasHub =
      surface === 'kanban' &&
      boardStyle === 'canvas' &&
      panelView === 'sessionHub';
    const dispatch = resolveFocusDispatch(
      { surface, isCanvasHub, routeWorkspaceId, routeSessionId },
      {
        projectId,
        workspaceId: focusRequest.workspaceId,
        sessionId: focusRequest.sessionId,
      }
    );

    switch (dispatch.kind) {
      case 'open-in-workspace':
        setRightPanelVisible(true);
        navigate(dispatch.navigateTo);
        break;
      case 'open-in-kanban-slot':
        setKanbanSessionVisible(true);
        activateExecutionSession(dispatch.placement);
        break;
      case 'reveal-on-canvas':
        requestCanvasReveal({
          projectId: dispatch.projectId,
          workspaceId: dispatch.workspaceId,
          sessionId: dispatch.sessionId,
        });
        break;
      case 'noop':
        // Already shown on the current surface — window focus alone is enough.
        break;
    }

    void attemptsApi.markSeen(focusRequest.workspaceId).catch(() => {
      // Ignore mark-seen failures for toast navigation.
    });
  }, [
    activateExecutionSession,
    activeTab,
    boardStyle,
    consumeProjectFocus,
    isLayoutHydrated,
    navigate,
    panelView,
    pendingProjectFocus,
    projectId,
    routeSessionId,
    routeWorkspaceId,
    setKanbanSessionVisible,
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
