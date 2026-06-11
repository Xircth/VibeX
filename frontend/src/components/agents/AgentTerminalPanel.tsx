import { Terminal } from 'lucide-react';
import type {
  AgentTerminalOutputSnapshot,
  AgentTerminalSnapshot,
} from '@/features/agents/types';
import { cn } from '@/lib/utils';

type AgentTerminalPanelProps = {
  terminals: AgentTerminalSnapshot[];
  snapshots: Record<string, AgentTerminalOutputSnapshot | null | undefined>;
};

export function AgentTerminalPanel({
  terminals,
  snapshots,
}: AgentTerminalPanelProps) {
  if (terminals.length === 0) return null;

  return (
    <div className="rounded-lg border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span>Terminals</span>
      </div>
      <div className="divide-y">
        {terminals.map((terminal) => {
          const snapshot = snapshots[terminal.id];
          const command = [terminal.command, ...terminal.args].join(' ');
          return (
            <div key={terminal.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate font-medium">{command}</span>
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 text-[11px]',
                    snapshot?.exit ? 'text-muted-foreground' : 'text-blue-600'
                  )}
                >
                  {snapshot?.exit ? 'closed' : 'live'}
                </span>
              </div>
              {snapshot?.output ? (
                <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed">
                  {snapshot.output}
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
