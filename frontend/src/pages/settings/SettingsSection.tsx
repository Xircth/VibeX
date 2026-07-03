import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SettingsSection({
  id,
  title,
  icon: Icon,
  expanded = true,
  onToggle,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  expanded?: boolean;
  onToggle?: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = `agent-settings-${id}`;

  return (
    <section className="settings-surface overflow-hidden rounded-xl">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        {onToggle ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-[13px] font-semibold text-foreground">
              {title}
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-[13px] font-semibold text-foreground">
              {title}
            </span>
          </div>
        )}
        {action}
      </div>
      {expanded ? (
        <div id={bodyId} className="px-3.5 pb-3.5 pt-1">
          {children}
        </div>
      ) : null}
    </section>
  );
}
