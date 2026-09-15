import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TextInput } from '@astryxdesign/core/TextInput';
import { astryxTextInputSurfaceStyle } from '@/components/ui/astryx-text-input';
import { Button } from '@/components/ui/button';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal, getErrorMessage } from '@/lib/modals';
import { useRenameBranch } from '@/hooks/useRenameBranch';

export interface EditBranchNameDialogProps {
  attemptId: string;
  currentBranchName: string;
}

export type EditBranchNameDialogResult = {
  action: 'confirmed' | 'canceled';
  branchName?: string;
};

const EditBranchNameDialogImpl = NiceModal.create<EditBranchNameDialogProps>(
  ({ attemptId, currentBranchName }) => {
    const { t } = useTranslation(['dialogs', 'common']);
    const modal = useModal();
    const [branchName, setBranchName] = useState<string>(currentBranchName);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      setBranchName(currentBranchName);
      setError(null);
    }, [currentBranchName]);

    const renameMutation = useRenameBranch(
      attemptId,
      (newBranch) => {
        modal.resolve({
          action: 'confirmed',
          branchName: newBranch,
        } as EditBranchNameDialogResult);
        modal.hide();
      },
      (err: unknown) => {
        setError(getErrorMessage(err) || 'Failed to rename branch');
      }
    );

    const handleConfirm = () => {
      const trimmedName = branchName.trim();

      if (!trimmedName) {
        setError('Branch name cannot be empty');
        return;
      }

      if (trimmedName === currentBranchName) {
        modal.resolve({ action: 'canceled' } as EditBranchNameDialogResult);
        modal.hide();
        return;
      }

      if (trimmedName.includes(' ')) {
        setError('Branch name cannot contain spaces');
        return;
      }

      setError(null);
      renameMutation.mutate(trimmedName);
    };

    const handleCancel = () => {
      modal.resolve({ action: 'canceled' } as EditBranchNameDialogResult);
      modal.hide();
    };

    const handleOpenChange = (open: boolean) => {
      if (!open) {
        handleCancel();
      }
    };

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('editBranchName.title')}</DialogTitle>
            <DialogDescription>
              {t('editBranchName.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('editBranchName.branchNameLabel')}
              </label>
              <TextInput
                label={t('editBranchName.branchNameLabel')}
                isLabelHidden
                value={branchName}
                onChange={(value) => {
                  setBranchName(value);
                  setError(null);
                }}
                onEnter={() => {
                  if (!renameMutation.isPending) {
                    handleConfirm();
                  }
                }}
                placeholder={t('editBranchName.placeholder')}
                isDisabled={renameMutation.isPending}
                hasAutoFocus
                width="100%"
                className="[&_input]:text-sm"
                style={astryxTextInputSurfaceStyle}
                status={error ? { type: 'error', message: error } : undefined}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={renameMutation.isPending}
            >
              {t('common:cancel')}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={renameMutation.isPending || !branchName.trim()}
            >
              {renameMutation.isPending
                ? t('editBranchName.renaming')
                : t('editBranchName.renameButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const EditBranchNameDialog = defineModal<
  EditBranchNameDialogProps,
  EditBranchNameDialogResult
>(EditBranchNameDialogImpl);
