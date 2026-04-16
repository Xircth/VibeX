import type { IDockviewPanelProps } from 'dockview-react';
import { Loader2, StickyNote } from 'lucide-react';

import { useWorktree } from '@/contexts/WorktreeContext';
import { useWorkspaceNotes } from '@/hooks/useWorkspaceNotes';

function DockviewNotesPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { content, setContent, isLoading } = useWorkspaceNotes(
    activeWorktreeId ?? undefined
  );

  if (!activeWorktreeId) {
    return (
      <div
        className="h-full w-full overflow-auto bg-background p-3"
        data-panel="notes"
      >
        <div className="mb-3 flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Notes</span>
        </div>
        <div className="flex h-[calc(100%-2rem)] items-center justify-center text-sm text-muted-foreground">
          Select a workspace to edit notes.
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-auto bg-background p-3"
      data-panel="notes"
    >
      <div className="mb-3 flex items-center gap-2">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Notes</span>
      </div>
      <textarea
        className="h-[calc(100%-2rem)] w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        placeholder={
          isLoading ? 'Loading notes...' : 'Write workspace notes here...'
        }
        value={isLoading ? '' : content}
        onChange={(event) => setContent(event.target.value)}
        disabled={isLoading}
      />
      {isLoading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

export default DockviewNotesPanel;
