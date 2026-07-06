import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { defineModal } from '@/lib/modals';
import { usePush } from '@/hooks/usePush';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTranslation } from 'react-i18next';
export interface ForcePushDialogProps {
  attemptId: string;
  repoId: string;
  branchName?: string;
}

const ForcePushDialogImpl = NiceModal.create<ForcePushDialogProps>((props) => {
  const { t } = useTranslation(['dialogs', 'common']);
  const modal = useModal();
  const { attemptId, repoId, branchName } = props;
  const [error, setError] = useState<string | null>(null);
  const branchLabel = branchName ? ` "${branchName}"` : '';

  const forcePush = usePush(
    attemptId,
    () => {
      // Success - close dialog
      modal.resolve('success');
      modal.hide();
    },
    (err: unknown) => {
      // Error - show in dialog and keep open
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String(err.message)
          : t('forcePush.pushFailed');
      setError(message);
    },
    { force: true }
  );

  const handleConfirm = async () => {
    setError(null);
    try {
      await forcePush.mutateAsync({ repo_id: repoId });
    } catch {
      // Error already handled by onError callback
    }
  };

  const handleCancel = () => {
    modal.resolve('canceled');
    modal.hide();
  };

  const isProcessing = forcePush.isPending;

  return (
    <Dialog open={modal.visible} onOpenChange={handleCancel}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <DialogTitle>{t('forcePush.title')}</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>{t('forcePush.description', { branch: branchLabel })}</p>
            <p className="font-medium">{t('forcePush.warning')}</p>
            <p className="text-sm text-muted-foreground">
              {t('forcePush.hint')}
            </p>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isProcessing}
          >
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isProcessing}
          >
            {isProcessing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isProcessing
              ? t('forcePush.processing')
              : t('forcePush.confirmButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const ForcePushDialog = defineModal<ForcePushDialogProps, string>(
  ForcePushDialogImpl
);
