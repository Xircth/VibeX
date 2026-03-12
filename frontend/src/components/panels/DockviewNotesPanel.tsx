import type { IDockviewPanelProps } from 'dockview-react';
import { StickyNote } from 'lucide-react';

function DockviewNotesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="h-full w-full overflow-auto bg-background p-3" data-panel="notes">
      <div className="flex items-center gap-2 mb-3">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">笔记</span>
      </div>
      <textarea
        className="w-full h-[calc(100%-2rem)] resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        placeholder="在此处编写笔记..."
      />
    </div>
  );
}

export default DockviewNotesPanel;
