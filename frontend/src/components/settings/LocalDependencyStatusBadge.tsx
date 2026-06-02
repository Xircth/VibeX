import { Badge } from '@/components/ui/badge';
import type { LocalToolStatus } from '@/lib/api';
import { getLocalDependencyStatusPresentation } from '@/lib/localDependencyMaintenance';
import { cn } from '@/lib/utils';

const toneClasses = {
  destructive:
    'border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/10',
  warning:
    'border-amber-500/25 bg-amber-500/10 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300',
  success:
    'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300',
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
