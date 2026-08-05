import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import BranchSelector from '@/components/tasks/BranchSelector';
import type { GitBranch } from 'shared/types';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/lib/modals';

export interface ChangeTargetBranchDialogProps {
  branches: GitBranch[];
  isChangingTargetBranch?: boolean;
}

export type ChangeTargetBranchDialogResult = {
  action: 'confirmed' | 'canceled';
  branchName?: string;
};

const ChangeTargetBranchDialogImpl =
  NiceModal.create<ChangeTargetBranchDialogProps>(
    ({ branches, isChangingTargetBranch: isChangingTargetBranch = false }) => {
      const { t } = useTranslation(['dialogs', 'common']);
      const modal = useModal();
      const [selectedBranch, setSelectedBranch] = useState<string>('');

      const handleConfirm = () => {
        if (selectedBranch) {
          modal.resolve({
            action: 'confirmed',
            branchName: selectedBranch,
          } as ChangeTargetBranchDialogResult);
          modal.hide();
        }
      };

      const handleCancel = () => {
        modal.resolve({ action: 'canceled' } as ChangeTargetBranchDialogResult);
        modal.hide();
      };

      const handleOpenChange = (open: boolean) => {
        if (!open) {
          handleCancel();
        }
      };

      return (
        <Dialog
          open={modal.visible}
          onOpenChange={handleOpenChange}
          className="sm:max-w-lg"
        >
          <DialogContent>
            <DialogTitle className="sr-only">
              {t('changeTargetBranch.title')}
            </DialogTitle>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] sm:items-end">
              <div className="space-y-2">
                <label htmlFor="base-branch" className="text-sm font-medium">
                  {t('changeTargetBranch.targetBranchLabel')}
                </label>
                <BranchSelector
                  triggerId="base-branch"
                  branches={branches}
                  selectedBranch={selectedBranch}
                  onBranchSelect={setSelectedBranch}
                  placeholder={t('changeTargetBranch.selectPlaceholder')}
                  excludeCurrentBranch={false}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Button
                  className="w-full"
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  disabled={isChangingTargetBranch}
                >
                  {t('common:cancel')}
                </Button>
                <Button
                  className="w-full"
                  size="sm"
                  onClick={handleConfirm}
                  disabled={isChangingTargetBranch || !selectedBranch}
                >
                  {isChangingTargetBranch
                    ? t('changeTargetBranch.changing')
                    : t('changeTargetBranch.changeBranch')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      );
    }
  );

export const ChangeTargetBranchDialog = defineModal<
  ChangeTargetBranchDialogProps,
  ChangeTargetBranchDialogResult
>(ChangeTargetBranchDialogImpl);
