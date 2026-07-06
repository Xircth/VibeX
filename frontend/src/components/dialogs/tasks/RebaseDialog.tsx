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
import { Button } from '@/components/ui/button';
import BranchSelector from '@/components/tasks/BranchSelector';
import type { GitBranch } from 'shared/types';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/lib/modals';

export interface RebaseDialogProps {
  branches: GitBranch[];
  isRebasing?: boolean;
  initialTargetBranch?: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
}

export type RebaseDialogResult = {
  action: 'confirmed' | 'canceled';
  branchName?: string;
};

const RebaseDialogImpl = NiceModal.create<RebaseDialogProps>(
  ({
    branches,
    isRebasing = false,
    initialTargetBranch,
    title: titleProp,
    description: descriptionProp,
    confirmLabel: confirmLabelProp,
  }) => {
    const { t } = useTranslation(['dialogs', 'common']);
    const title = titleProp ?? t('rebase.title');
    const description = descriptionProp ?? t('rebase.description');
    const confirmLabel = confirmLabelProp ?? t('rebase.confirm');
    const modal = useModal();
    const [selectedBranch, setSelectedBranch] = useState<string>(
      initialTargetBranch ?? ''
    );

    useEffect(() => {
      if (initialTargetBranch) {
        setSelectedBranch(initialTargetBranch);
      }
    }, [initialTargetBranch]);

    const handleConfirm = () => {
      if (!selectedBranch) {
        return;
      }

      modal.resolve({
        action: 'confirmed',
        branchName: selectedBranch,
      } as RebaseDialogResult);
      modal.hide();
    };

    const handleCancel = () => {
      modal.resolve({ action: 'canceled' } as RebaseDialogResult);
      modal.hide();
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => !open && handleCancel()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label htmlFor="target-branch" className="text-sm font-medium">
              {t('rebase.targetBranchLabel')}
            </label>
            <BranchSelector
              branches={branches}
              selectedBranch={selectedBranch}
              onBranchSelect={setSelectedBranch}
              placeholder={t('rebase.targetBranchPlaceholder')}
              excludeCurrentBranch={false}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isRebasing}
            >
              {t('common:cancel')}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isRebasing || !selectedBranch}
            >
              {isRebasing ? t('rebase.processing') : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const RebaseDialog = defineModal<RebaseDialogProps, RebaseDialogResult>(
  RebaseDialogImpl
);
