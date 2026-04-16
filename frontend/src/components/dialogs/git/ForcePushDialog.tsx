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
export interface ForcePushDialogProps {
  attemptId: string;
  repoId: string;
  branchName?: string;
}

const ForcePushDialogImpl = NiceModal.create<ForcePushDialogProps>((props) => {
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
          : '强制推送失败';
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
            <DialogTitle>{'需要强制推送'}</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2 space-y-2">
            <p>{`远程分支${branchLabel}已与您的本地分支分离。常规推送被拒绝。`}</p>
            <p className="font-medium">
              {'强制推送将用您的本地更改覆盖远程更改。此操作无法撤消。'}
            </p>
            <p className="text-sm text-muted-foreground">
              {'仅当您确定要替换远程分支历史记录时才继续。'}
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
            {'取消'}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isProcessing}
          >
            {isProcessing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isProcessing ? '强制推送中...' : '强制推送'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const ForcePushDialog = defineModal<ForcePushDialogProps, string>(
  ForcePushDialogImpl
);
