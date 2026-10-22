import type { IDockviewPanelProps } from 'dockview-react';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { WorkspaceActivityPanel } from '@/features/workspace-activity/WorkspaceActivityPanel';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';

export default function DockviewProcessesPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const workspaceId =
    visibleRightSession?.workspaceId ?? activeWorktreeId ?? undefined;
  const { data: attempt } = useTaskAttemptWithSession(workspaceId);
  const sessionId =
    visibleRightSession?.sessionId ?? attempt?.session?.id ?? undefined;

  return (
    <WorkspaceActivityPanel workspaceId={workspaceId} sessionId={sessionId} />
  );
}
