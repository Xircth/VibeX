import { useState } from 'react';
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
        <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{'更改目标分支'}</DialogTitle>
              <DialogDescription>
                {'为任务尝试选择新的目标分支。'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="base-branch" className="text-sm font-medium">
                  {'目标分支'}
                </label>
                <BranchSelector
                  branches={branches}
                  selectedBranch={selectedBranch}
                  onBranchSelect={setSelectedBranch}
                  placeholder={'选择目标分支'}
                  excludeCurrentBranch={false}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={isChangingTargetBranch}
              >
                {'取消'}
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={isChangingTargetBranch || !selectedBranch}
              >
                {isChangingTargetBranch ? '更改中...' : '更改分支'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    }
  );

export const ChangeTargetBranchDialog = defineModal<
  ChangeTargetBranchDialogProps,
  ChangeTargetBranchDialogResult
>(ChangeTargetBranchDialogImpl);
