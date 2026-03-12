import type { IDockviewPanelProps } from 'dockview-react';
import { MessageSquare } from 'lucide-react';

/**
 * DockviewAIChatPanel - Dockview wrapper for the AI chat panel.
 *
 * Note: This panel is registered in dockview for completeness but the AI Chat
 * panel is actually rendered as a FIXED panel outside of dockview (in the right
 * area of WorkspaceLayout). This component is only used if someone explicitly
 * adds it to the dockview layout.
 *
 * The actual AI chat content (TaskFollowUpSection) is rendered via the
 * rightPanelContent prop of IDELayout.
 */
function DockviewAIChatPanel(_props: IDockviewPanelProps) {
  return (
    <div className="h-full w-full overflow-auto p-4" data-panel="ai-chat">
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-3">
        <MessageSquare className="h-8 w-8 opacity-40" />
        <div className="text-center space-y-1">
          <p className="font-medium">AI Chat</p>
          <p className="text-xs">
            AI Chat is available in the fixed right panel
          </p>
        </div>
      </div>
    </div>
  );
}

export default DockviewAIChatPanel;
