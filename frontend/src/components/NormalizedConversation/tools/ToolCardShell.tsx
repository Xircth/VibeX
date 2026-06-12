import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ToolStatus } from 'shared/types';
import { cn } from '@/lib/utils';

type ToolCardShellProps = {
  icon?: ReactNode;
  label: string;
  detail?: ReactNode;
  actions?: ReactNode;
  statusClassName?: string;
  statusDotClassName?: string;
  expanded?: boolean;
  expandable?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
};

export function getToolStatusClassName(status?: ToolStatus | null): string {
  if (!status) return '';

  if (
    status.status === 'failed' ||
    status.status === 'denied' ||
    status.status === 'timed_out'
  ) {
    return 'conv-tool-card-error';
  }

  if (status.status === 'created' || status.status === 'pending_approval') {
    return 'conv-tool-card-pending';
  }

  return '';
}

export function getToolStatusDotClassName(status?: ToolStatus | null): string {
  if (!status) return '';

  if (
    status.status === 'failed' ||
    status.status === 'denied' ||
    status.status === 'timed_out'
  ) {
    return 'conv-tool-dot conv-tool-dot-error';
  }

  if (status.status === 'created' || status.status === 'pending_approval') {
    return 'conv-tool-dot conv-tool-dot-pending';
  }

  return '';
}

export function ToolCardShell({
  icon,
  label,
  detail,
  actions,
  statusClassName,
  statusDotClassName,
  expanded = false,
  expandable = false,
  onToggle,
  children,
}: ToolCardShellProps) {
  const stringDetail =
    typeof detail === 'string' || typeof detail === 'number'
      ? String(detail)
      : '';
  const accessibleLabel = stringDetail ? `${label} ${stringDetail}` : label;

  const handleToggle = () => {
    if (!expandable) return;
    onToggle?.();
  };

  return (
    <div className="w-full">
      <div
        onClick={expandable ? handleToggle : undefined}
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm conv-tool-card',
          statusClassName,
          expandable ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        {expandable ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleToggle();
            }}
            aria-expanded={expanded}
            aria-label={accessibleLabel}
            className="min-w-0 flex flex-1 items-center gap-2 bg-transparent p-0 text-left"
          >
            {icon ? (
              <span className="shrink-0 conv-tool-icon">{icon}</span>
            ) : null}
            <span className="conv-tool-label shrink-0">{label}</span>
            {detail ? (
              <span className="conv-tool-detail font-mono truncate min-w-0">
                {detail}
              </span>
            ) : null}
          </button>
        ) : (
          <div className="min-w-0 flex flex-1 items-center gap-2">
            {icon ? (
              <span className="shrink-0 conv-tool-icon">{icon}</span>
            ) : null}
            <span className="conv-tool-label shrink-0">{label}</span>
            {detail ? (
              <span className="conv-tool-detail font-mono truncate min-w-0">
                {detail}
              </span>
            ) : null}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {actions ? (
            <span
              className="flex items-center gap-1"
              onClick={(event) => event.stopPropagation()}
            >
              {actions}
            </span>
          ) : null}
          {statusDotClassName ? <span className={statusDotClassName} /> : null}
          {expandable ? (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                expanded ? '' : '-rotate-90'
              )}
            />
          ) : null}
        </div>
      </div>
      {expanded && children ? (
        <div className="conv-tool-details text-xs font-mono">{children}</div>
      ) : null}
    </div>
  );
}
