import { useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { WorktreeProvider, useWorktree } from '@/contexts/WorktreeContext';
import { KanbanSessionProvider } from '@/contexts/KanbanSessionContext';
import { PanelActionsProvider } from '@/contexts/PanelActionsContext';
import { TerminalProvider } from '@/contexts/TerminalContext';
import { ReviewProvider } from '@/contexts/ReviewProvider';
import { IDELayout } from '@/components/layout/IDELayout';
import { AcpTerminalBridge } from '@/components/layout/AcpTerminalBridge';

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
