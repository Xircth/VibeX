import { Badge } from '@astryxdesign/core/Badge';
import type { LocalToolStatus } from '@/lib/api';
import { getLocalDependencyStatusPresentation } from '@/lib/localDependencyMaintenance';

const toneToVariant = {
  destructive: 'error',
  warning: 'warning',
  success: 'success',
  muted: 'neutral',
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
      variant={toneToVariant[presentation.tone]}
      label={presentation.label}
      className={className}
    />
  );
}
