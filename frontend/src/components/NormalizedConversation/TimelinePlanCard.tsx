import { Check, Circle, CircleDot, ClipboardList } from 'lucide-react';
import type { PlanEntry } from 'shared/types';
import { cn } from '@/lib/utils';

/**
 * Renders a unified-timeline `Plan` block (parsed from TodoWrite / update_plan)
 * as a checklist, consuming the normalized
 * `PlanEntry[]` directly instead of a NormalizedEntry. VibeX-authored.
 */

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  }
  if (status === 'in_progress') {
    return <CircleDot className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
  }
  return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

export function TimelinePlanCard({ entries }: { entries: PlanEntry[] }) {
  const completed = entries.filter(
    (entry) => entry.status === 'completed'
  ).length;
  return (
    <div className="conv-tool-card">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
        <ClipboardList className="h-3.5 w-3.5 shrink-0 conv-tool-icon" />
        <span className="conv-tool-label">Plan</span>
        <span className="conv-tool-detail font-mono">
          {completed}/{entries.length}
        </span>
      </div>
      <ul className="conv-tool-details space-y-1 text-sm leading-5">
        {entries.map((entry, index) => (
          <li key={index} className="flex items-start gap-2">
            <span className="mt-0.5">
              <StatusIcon status={entry.status} />
            </span>
            <span
              className={cn(
                'min-w-0',
                entry.status === 'completed' &&
                  'text-muted-foreground line-through'
              )}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
