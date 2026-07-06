import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import { APP_NAME } from '@/lib/branding';
import { defineModal, type NoProps } from '@/lib/modals';

const DisclaimerDialogImpl = NiceModal.create<NoProps>(() => {
  const modal = useModal();
  const { t } = useTranslation(['dialogs', 'common']);

  const handleAccept = () => {
    modal.resolve('accepted');
  };

  return (
    <Dialog open={modal.visible} uncloseable={true}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <DialogTitle>{t('disclaimer.title')}</DialogTitle>
          </div>
          <DialogDescription className="text-left space-y-4 pt-4">
            <p>
              {t('disclaimer.runModeIntro', { appName: APP_NAME })}{' '}
              <code>--dangerously-skip-permissions</code> /{' '}
              <code>--yolo</code> {t('disclaimer.runModeAccess')}
            </p>
            <p>
              <strong>{t('disclaimer.importantLabel')}</strong>
              {t('disclaimer.importantBody')}
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleAccept} variant="default">
            {t('disclaimer.acceptButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const DisclaimerDialog = defineModal<void, 'accepted' | void>(
  DisclaimerDialogImpl
);
