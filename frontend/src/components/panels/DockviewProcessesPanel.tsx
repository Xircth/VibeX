import type { IDockviewPanelProps } from 'dockview-react';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { WorkspaceActivityPanel } from '@/features/workspace-activity/WorkspaceActivityPanel';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';

interface DockviewProcessesPanelParams {
  sessionId?: string;
  workspaceId?: string;
}

export default function DockviewProcessesPanel(
  props: IDockviewPanelProps<DockviewProcessesPanelParams>
) {
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const paramWorkspaceId =
    typeof props.params?.workspaceId === 'string' &&
    props.params.workspaceId.trim().length > 0
      ? props.params.workspaceId
      : undefined;
  const paramSessionId =
    typeof props.params?.sessionId === 'string' &&
    props.params.sessionId.trim().length > 0
      ? props.params.sessionId
      : undefined;
  const workspaceId =
    paramWorkspaceId ??
    visibleRightSession?.workspaceId ??
    activeWorktreeId ??
    undefined;
  const { data: attempt } = useTaskAttemptWithSession(workspaceId);
  const sessionId =
    paramSessionId ??
    visibleRightSession?.sessionId ??
    attempt?.session?.id ??
    undefined;

  return (
    <WorkspaceActivityPanel workspaceId={workspaceId} sessionId={sessionId} />
  );
}

