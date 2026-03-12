import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';import {
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
  initialUpstreamBranch?: string;
}

export type RebaseDialogResult = {
  action: 'confirmed' | 'canceled';
  branchName?: string;
  upstreamBranch?: string;
};

const RebaseDialogImpl = NiceModal.create<RebaseDialogProps>(
  ({
    branches,
    isRebasing = false,
    initialTargetBranch,
    initialUpstreamBranch,
  }) => {
    const modal = useModal();    const [selectedBranch, setSelectedBranch] = useState<string>(
      initialTargetBranch ?? ''
    );
    const [selectedUpstream, setSelectedUpstream] = useState<string>(
      initialUpstreamBranch ?? ''
    );

    useEffect(() => {
      if (initialTargetBranch) {
        setSelectedBranch(initialTargetBranch);
      }
    }, [initialTargetBranch]);

    useEffect(() => {
      if (initialUpstreamBranch) {
        setSelectedUpstream(initialUpstreamBranch);
      }
    }, [initialUpstreamBranch]);

    const [showAdvanced, setShowAdvanced] = useState(false);

    const handleConfirm = () => {
      if (selectedBranch) {
        modal.resolve({
          action: 'confirmed',
          branchName: selectedBranch,
          upstreamBranch: selectedUpstream,
        } as RebaseDialogResult);
        modal.hide();
      }
    };

    const handleCancel = () => {
      modal.resolve({ action: 'canceled' } as RebaseDialogResult);
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
            <DialogTitle>{'变基任务尝试'}</DialogTitle>
            <DialogDescription>
              {'选择一个新的基础分支以将此任务尝试变基到其上。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="target-branch" className="text-sm font-medium">
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
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((prev) => !prev)}
                className="flex w-full items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                />
                <span>{'高级'}</span>
              </button>
              {showAdvanced && (
                <div className="space-y-2">
                  <label
                    htmlFor="upstream-branch"
                    className="text-sm font-medium"
                  >
                    {'上游分支'}
                  </label>
                  <BranchSelector
                    branches={branches}
                    selectedBranch={selectedUpstream}
                    onBranchSelect={setSelectedUpstream}
                    placeholder={'选择上游分支'}
                    excludeCurrentBranch={false}
                  />
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isRebasing}
            >
              {'取消'}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isRebasing || !selectedBranch}
            >
              {isRebasing
                ? '变基中...'
                : '变基'}
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
