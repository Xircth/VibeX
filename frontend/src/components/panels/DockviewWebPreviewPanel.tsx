import type { IDockviewPanelProps } from 'dockview-react';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { useKanbanSessionContext } from '@/contexts/KanbanSessionContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { PreviewPanel } from '@/components/panels/PreviewPanel';
import type { WebPreviewPanelParams } from '@/types/panels';

export default function DockviewWebPreviewPanel(props: IDockviewPanelProps) {
  const params = (props.params ?? {}) as Partial<WebPreviewPanelParams>;
  const { activeWorktreeId } = useWorktree();
  const { visibleRightSession } = useKanbanSessionContext();
  const workspaceId =
    visibleRightSession?.workspaceId ?? activeWorktreeId ?? undefined;
  const { data: attempt } = useTaskAttemptWithSession(workspaceId);
  const executionKey = `${workspaceId ?? 'none'}:${attempt?.session?.id ?? 'none'}`;

  return (
    <ExecutionProcessesProvider
      key={executionKey}
      attemptId={workspaceId}
      sessionId={attempt?.session?.id}
    >
      <PreviewPanel
        workspaceId={workspaceId}
        requestedUrl={params.requestedUrl ?? null}
        requestedUrlNonce={params.requestedUrlNonce ?? 0}
      />
    </ExecutionProcessesProvider>
  );
}
