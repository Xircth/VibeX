import { memo } from 'react';

interface GitStatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_META: Record<
  string,
  { label: string; title: string; className: string }
> = {
  A: {
    label: 'A',
    title: 'Added',
    className: 'text-[hsl(var(--success))]',
  },
  M: {
    label: 'M',
    title: 'Modified',
    className: 'text-[hsl(var(--warning))]',
  },
  D: {
    label: 'D',
    title: 'Deleted',
    className: 'text-destructive',
  },
  R: {
    label: 'R',
    title: 'Renamed',
    className: 'text-[hsl(var(--info))]',
  },
  U: {
    label: 'U',
    title: 'Untracked',
    className: 'text-muted-foreground',
  },
};

function normalizeStatus(status: string): string {
  if (status === '?') return 'U';
  return status.toUpperCase();
}

export const GitStatusBadge = memo(function GitStatusBadge({
  status,
  className = '',
}: GitStatusBadgeProps) {
  const normalized = normalizeStatus(status);
  const meta = STATUS_META[normalized] ?? {
    label: normalized,
    title: normalized,
    className: 'text-muted-foreground',
  };

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center text-[11px] font-bold leading-none ${meta.className} ${className}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
});
