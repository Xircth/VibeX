import type { IDockviewPanelProps } from 'dockview-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { ScrollText } from 'lucide-react';

function DockviewLogsPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();

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

  return (
    <div className="h-full w-full overflow-auto bg-background p-3 text-xs font-mono" data-panel="logs">
      <p className="text-muted-foreground">Logs for workspace {activeWorktreeId}</p>
      {/* TODO: integrate with VirtualizedList / EntriesProvider from TaskAttemptPanel */}
    </div>
  );
}

export default DockviewLogsPanel;
