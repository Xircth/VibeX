import { ClickedElementsProvider } from '@/contexts/ClickedElementsProvider';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { PreviewPanel } from '@/components/panels/PreviewPanel';

export default function DockviewDevPreviewPanel() {
  const { activeWorktreeId } = useWorktree();
  const workspaceId = activeWorktreeId ?? undefined;
  const { data: attempt } = useTaskAttemptWithSession(workspaceId);
  const executionKey = `${workspaceId ?? 'none'}:${attempt?.session?.id ?? 'none'}`;

  return (
    <ClickedElementsProvider attempt={attempt}>
      <ExecutionProcessesProvider
        key={executionKey}
        attemptId={workspaceId}
        sessionId={attempt?.session?.id}
      >
        <PreviewPanel />
      </ExecutionProcessesProvider>
    </ClickedElementsProvider>
  );
}
