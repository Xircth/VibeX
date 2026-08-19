import { MessageSquare, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type AutomationTypeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (type: 'turn' | 'workflow') => void;
};

export function AutomationTypeDialog({
  open,
  onOpenChange,
  onSelect,
}: AutomationTypeDialogProps) {
  const { t } = useTranslation('settings');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{t('automations.chooseType')}</DialogTitle>
        <DialogDescription>{t('automations.typePermanent')}</DialogDescription>
      </DialogHeader>
      <DialogContent className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          className="settings-surface group !h-auto !min-h-32 rounded-lg p-4 text-left outline-none transition-[border-color,box-shadow] hover:border-primary/45 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          aria-label={t('automations.singleSession')}
          onClick={() => onSelect('turn')}
        >
          <span className="grid size-9 place-items-center rounded-lg bg-[var(--surface-control)] text-muted-foreground group-hover:text-foreground">
            <MessageSquare className="size-4" />
          </span>
          <span className="mt-3 block text-sm font-semibold">
            {t('automations.singleSession')}
          </span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            {t('automations.singleSessionDescription')}
          </span>
        </button>
        <button
          type="button"
          className="settings-surface group !h-auto !min-h-32 rounded-lg p-4 text-left outline-none transition-[border-color,box-shadow] hover:border-primary/45 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          aria-label={t('automations.targetWorkflow')}
          onClick={() => onSelect('workflow')}
        >
          <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <Workflow className="size-4" />
          </span>
          <span className="mt-3 block text-sm font-semibold">
            {t('automations.targetWorkflow')}
          </span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            {t('automations.workflowTypeDescription')}
          </span>
        </button>
      </DialogContent>
    </Dialog>
  );
}
