import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function RightPanelNewSessionPrompt({
  onCreateSession,
  className,
}: {
  onCreateSession: () => void;
  className?: string;
}) {
  const { t } = useTranslation(['panels', 'common']);
  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 text-center',
        className
      )}
    >
      <p className="text-sm text-muted-foreground">
        {t('newSessionPrompt.emptyState')}
      </p>
      <Button className="gap-1.5" onClick={onCreateSession}>
        <Plus className="h-3.5 w-3.5" />
        {t('newSessionPrompt.newSession')}
      </Button>
    </div>
  );
}
