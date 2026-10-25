import * as React from 'react';

import { cn } from '@/lib/utils';

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Optional leading icon. Rendered at 20px in a muted, neutral tile. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional call to action (usually a small Button). */
  action?: React.ReactNode;
  /** `compact` drops the vertical padding for inline / sidebar empties. */
  size?: 'default' | 'compact';
}

/**
 * Shared empty / zero-data placeholder. Neutral by design: the accent color is
 * reserved for selected / focus / primary / live state, so nothing here uses it.
 */
const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      icon,
      title,
      description,
      action,
      size = 'default',
      className,
      role = 'status',
      ...props
    },
    ref
  ) => (
    <div
      ref={ref}
      role={role}
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        size === 'compact' ? 'px-3 py-4' : 'px-6 py-10',
        className
      )}
      {...props}
    >
      {icon != null ? (
        <span
          aria-hidden="true"
          className="mb-1 grid size-9 place-items-center rounded-[var(--radius)] bg-[var(--surface-control)] text-muted-foreground [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description != null ? (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action != null ? <div className="mt-2">{action}</div> : null}
    </div>
  )
);
EmptyState.displayName = 'EmptyState';

export { EmptyState };
