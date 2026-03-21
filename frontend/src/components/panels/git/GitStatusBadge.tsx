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
    className: 'text-green-600 bg-green-500/10 border-green-500/30',
  },
  M: {
    label: 'M',
    title: 'Modified',
    className: 'text-amber-600 bg-amber-500/10 border-amber-500/30',
  },
  D: {
    label: 'D',
    title: 'Deleted',
    className: 'text-red-600 bg-red-500/10 border-red-500/30',
  },
  R: {
    label: 'R',
    title: 'Renamed',
    className: 'text-blue-600 bg-blue-500/10 border-blue-500/30',
  },
  U: {
    label: 'U',
    title: 'Untracked',
    className: 'text-slate-500 bg-slate-500/10 border-slate-500/30',
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
