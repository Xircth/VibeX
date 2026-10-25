import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Expandable ranking row used by the usage dashboard (folders / agents /
 * models). Opaque surface with --radius corners; the expanded state is shown by
 * the rotated chevron and aria-expanded, not by an accent border.
 */
export function UsageExpandableRow({
  expanded,
  onToggle,
  children,
  detail,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** Row summary content rendered inside the toggle button. */
  children: ReactNode;
  /** Rendered beneath the row while expanded. */
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="usage-expandable-row" data-expanded={expanded || undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'flex min-h-12 w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-content)] px-4 py-2 text-left transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          expanded && 'bg-[var(--surface-control-hover)]',
          className
        )}
      >
        {children}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
        />
      </button>
      {expanded && detail ? detail : null}
    </div>
  );
}
