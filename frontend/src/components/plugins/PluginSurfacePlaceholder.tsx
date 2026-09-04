import { Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export type PluginSurfacePlaceholderReason =
  | 'disabled'
  | 'missing'
  | 'failed'
  | 'uninstalled';

export function PluginSurfacePlaceholder({
  reason,
  onRecover,
}: {
  reason: PluginSurfacePlaceholderReason;
  onRecover?: () => void;
}) {
  const { t } = useTranslation('panels');
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="plugin-surface-placeholder"
      data-reason={reason}
    >
      <Puzzle className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-sm text-sm text-muted-foreground">
        {t(`surface.placeholder.${reason}`)}
      </p>
      {onRecover ? (
        <Button type="button" size="sm" variant="outline" onClick={onRecover}>
          {t(`surface.placeholder.recover.${reason}`)}
        </Button>
      ) : null}
    </div>
  );
}
