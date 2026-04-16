import type { IDockviewPanelProps } from 'dockview-react';
import { Loader2, ScrollText } from 'lucide-react';

import VirtualizedList from '@/components/logs/VirtualizedList';
import { EntriesProvider } from '@/contexts/EntriesContext';
import { ExecutionProcessesProvider } from '@/contexts/ExecutionProcessesContext';
import { RetryUiProvider } from '@/contexts/RetryUiContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';

function DockviewLogsPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { data: attempt, isLoading: isLoadingAttempt } =
    useTaskAttemptWithSession(activeWorktreeId ?? undefined);

  if (!activeWorktreeId) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <ScrollText className="h-8 w-8 opacity-40 mx-auto" />
          <p>选择一个工作区以查看日志</p>
        </div>
      </div>
    );
  }

  if (isLoadingAttempt) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <Loader2 className="h-8 w-8 animate-spin opacity-70 mx-auto" />
          <p>Loading logs...</p>
        </div>
      </div>
    );
  }

  if (!attempt) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <ScrollText className="h-8 w-8 opacity-40 mx-auto" />
          <p>Logs unavailable for this workspace.</p>
        </div>
      </div>
    );
  }

  const conversationKey = `${attempt.id}:${attempt.session?.id ?? 'unknown'}:logs`;

  return (
    <EntriesProvider key={conversationKey} cacheKey={conversationKey}>
      <ExecutionProcessesProvider
        key={conversationKey}
        attemptId={attempt.id}
        sessionId={attempt.session?.id}
      >
        <RetryUiProvider attemptId={attempt.id}>
          <div className="h-full w-full bg-background" data-panel="logs">
            <VirtualizedList attempt={attempt} task={null} />
          </div>
        </RetryUiProvider>
      </ExecutionProcessesProvider>
    </EntriesProvider>
  );
}

export default DockviewLogsPanel;
