import { useEffect, useState } from 'react';
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
    title = '选择目标分支',
    description = '选择一个目标分支继续执行当前 Git 操作。',
    confirmLabel = '确认',
  }) => {
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
      <Dialog open={modal.visible} onOpenChange={(open) => !open && handleCancel()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label htmlFor="target-branch" className="text-sm font-medium">
              目标分支
            </label>
            <BranchSelector
              branches={branches}
              selectedBranch={selectedBranch}
              onBranchSelect={setSelectedBranch}
              placeholder="选择目标分支"
              excludeCurrentBranch={false}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCancel} disabled={isRebasing}>
              取消
            </Button>
            <Button onClick={handleConfirm} disabled={isRebasing || !selectedBranch}>
              {isRebasing ? '处理中...' : confirmLabel}
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
