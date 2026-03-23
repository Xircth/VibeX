import { useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useProject } from '@/contexts/ProjectContext';
import { WorktreeProvider, useWorktree } from '@/contexts/WorktreeContext';
import { KanbanSessionProvider, useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { PanelActionsProvider } from '@/contexts/PanelActionsContext';
import { TerminalProvider } from '@/contexts/TerminalContext';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import { IDELayout } from '@/components/layout/IDELayout';
import { AcpTerminalBridge } from '@/components/layout/AcpTerminalBridge';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { attemptsApi } from '@/lib/api';

interface WorkspaceLayoutProps {
  /** Content for the right fixed panel (AI Chat area) */
  rightPanelContent?: ReactNode;
  /** Content for the toolbar area */
  toolbarContent?: ReactNode;
}

/**
 * Syncs URL params (attemptId, taskId) to WorktreeContext.
 * Must be rendered inside WorktreeProvider.
 */
function WorktreeSyncFromUrl() {
  const { attemptId, taskId } = useParams<{
    attemptId?: string;
    taskId?: string;
  }>();
  const { setActiveWorktree } = useWorktree();

  useEffect(() => {
    setActiveWorktree(attemptId ?? null, taskId ?? null);
  }, [attemptId, taskId, setActiveWorktree]);

  return null;
}

function PendingProjectFocusBridge() {
  const { projectId } = useProject();
  const { replaceRightSession, goToBoard } = useKanbanSessionContext();
  const consumeProjectFocus = useWindowProjectsStore(
    (state) => state.consumeProjectFocus
  );
  const setActiveTab = useLayoutStore((state) => state.setActiveTab);
  const setRightPanelVisible = useLayoutStore(
    (state) => state.setRightPanelVisible
  );

  useEffect(() => {
    if (!projectId) {
      return;
    }

    const focusRequest = consumeProjectFocus(projectId);
    if (!focusRequest) {
      return;
    }

    setActiveTab('kanban');
    setRightPanelVisible(true);
    goToBoard();
    replaceRightSession({
      workspaceId: focusRequest.workspaceId,
      sessionId: focusRequest.sessionId,
    });

    void attemptsApi.markSeen(focusRequest.workspaceId).catch(() => {
      // Ignore mark-seen failures for toast navigation.
    });
  }, [
    consumeProjectFocus,
    goToBoard,
    projectId,
    replaceRightSession,
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
      <WorktreeSyncFromUrl />
      <KanbanSessionProvider>
        <PendingProjectFocusBridge />
        <ReviewProvider>
          <TerminalProvider>
            <PanelActionsProvider>
              <AcpTerminalBridge />
              <IDELayout
                rightPanelContent={rightPanelContent}
                toolbarContent={toolbarContent}
              />
            </PanelActionsProvider>
          </TerminalProvider>
        </ReviewProvider>
      </KanbanSessionProvider>
    </WorktreeProvider>
  );
}
