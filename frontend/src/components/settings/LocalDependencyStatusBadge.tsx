import { Badge } from '@/components/ui/badge';
import type { LocalToolStatus } from '@/lib/api';
import { getLocalDependencyStatusPresentation } from '@/lib/localDependencyMaintenance';
import { cn } from '@/lib/utils';

const toneClasses = {
  destructive:
    'border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/10',
  warning:
    'border-[hsl(var(--warning)/0.25)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.1)]',
  success:
    'border-[hsl(var(--success)/0.25)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))] hover:bg-[hsl(var(--success)/0.1)]',
  muted:
    'border-border bg-muted/50 text-muted-foreground hover:bg-muted/50',
} as const;

export function LocalDependencyStatusBadge({
  tool,
  className,
}: {
  tool: LocalToolStatus;
  className?: string;
}) {
  const presentation = getLocalDependencyStatusPresentation(tool);

  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        toneClasses[presentation.tone],
        className
      )}
    >
      {presentation.label}
    </Badge>
  );
}
