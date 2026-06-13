import { memo } from 'react';

interface GitStatusBadgeProps {
  status: string;
}

const STATUS_META: Record<
  string,
  { label: string; title: string; className: string }
> = {
  A: {
    label: 'A',
    title: 'Added',
    className:
      'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]',
  },
  M: {
    label: 'M',
    title: 'Modified',
    className:
      'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]',
  },
  D: {
    label: 'D',
    title: 'Deleted',
    className:
      'border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] text-destructive',
  },
  R: {
    label: 'R',
    title: 'Renamed',
    className:
      'border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]',
  },
  U: {
    label: 'U',
    title: 'Untracked',
    className: 'border-border/40 bg-muted/20 text-muted-foreground',
  },
};

function normalizeStatus(status: string): string {
  if (status === '?') return 'U';
  return status.toUpperCase();
}

export const GitStatusBadge = memo(function GitStatusBadge({
  status,
}: GitStatusBadgeProps) {
  const normalized = normalizeStatus(status);
  const meta = STATUS_META[normalized] ?? {
    label: normalized,
    title: normalized,
    className: 'text-muted-foreground bg-muted/20 border-border/40',
  };

  return (
    <span
      className={`inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded border px-1 text-[10px] font-semibold leading-none ${meta.className}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  );
});
