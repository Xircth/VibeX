import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentPreflightItemView } from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { defineModal, type ConfirmResult } from '@/lib/modals';

type Props = {
  items: AgentPreflightItemView[];
};

const AgentUpdateConfirmDialogImpl = NiceModal.create<Props>((props) => {
  const modal = useModal();
  const { t, i18n } = useTranslation(['settings', 'common']);
  const english = i18n.resolvedLanguage?.startsWith('en') ?? false;

  const confirm = () => {
    modal.resolve('confirmed' as ConfirmResult);
    modal.hide();
  };
  const cancel = () => {
    modal.resolve('canceled' as ConfirmResult);
    modal.hide();
  };

  return (
    <Dialog
      open={modal.visible}
      className="!max-w-[440px] sm:!max-w-[440px]"
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="agent-update-dialog-icon" aria-hidden="true">
            <RefreshCw />
          </div>
          <DialogTitle>{t('agents.updateConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('agents.updateConfirmMessage')}
          </DialogDescription>
        </DialogHeader>
        <ul className="agent-update-dialog-list">
          {props.items.map((item) => (
            <li key={item.id}>
              <strong>
                {english ? item.id.replaceAll('_', ' ') : item.label}
              </strong>
              <div className="agent-update-dialog-versions">
                <code>{item.version || t('agents.versionUnknown')}</code>
                <ArrowRight aria-hidden="true" />
                <code>
                  {item.available_version || t('agents.versionUnknown')}
                </code>
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            {t('common:cancel')}
          </Button>
          <Button onClick={confirm}>{t('agents.updateNow')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const AgentUpdateConfirmDialog = defineModal<Props, ConfirmResult>(
  AgentUpdateConfirmDialogImpl
);
