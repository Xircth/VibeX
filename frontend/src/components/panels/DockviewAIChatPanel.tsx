import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { MessageSquare } from 'lucide-react';
import { useRightPanelSlot } from '@/contexts/RightPanelSlotContext';

/**
 * DockviewAIChatPanel - dockview host for the session (C zone) on the
 * workspace page.
 *
 * The session content lives in a shared host element (see
 * `RightPanelSlotContext`); this panel adopts that host while the workspace
 * page owns the placement. The kanban page's session slot adopts it
 * otherwise. Re-parenting the host keeps the conversation mounted across
 * tab switches.
 */
function DockviewAIChatPanel(_props: IDockviewPanelProps) {
  const { host, placement } = useRightPanelSlot();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host || placement !== 'workspace') return;

    const container = containerRef.current;
    if (!container) return;

    container.appendChild(host);
    return () => {
      if (host.parentElement === container) {
        container.removeChild(host);
      }
    };
  }, [host, placement]);

  if (!host) {
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

  return (
    <div
      ref={containerRef}
      className="workspace-right-panel h-full w-full min-w-0 overflow-hidden"
      data-panel="ai-chat"
    />
  );
}

export default DockviewAIChatPanel;
