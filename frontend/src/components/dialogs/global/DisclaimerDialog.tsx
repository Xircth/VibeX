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
import { APP_NAME } from '@/lib/branding';
import { defineModal, type NoProps } from '@/lib/modals';

const DisclaimerDialogImpl = NiceModal.create<NoProps>(() => {
  const modal = useModal();

  const handleAccept = () => {
    modal.resolve('accepted');
  };

  return (
    <Dialog open={modal.visible} uncloseable={true}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <DialogTitle>安全提示</DialogTitle>
          </div>
          <DialogDescription className="text-left space-y-4 pt-4">
            <p>
              {APP_NAME} 默认以{' '}
              <code>--dangerously-skip-permissions</code> / <code>--yolo</code>{' '}
              模式运行 AI 编程 Agent，赋予其在你系统上执行代码和运行命令的完全访问权限。
            </p>
            <p>
              <strong>重要：</strong>请始终关注 Agent 的操作行为，并确保重要工作已备份。本软件仍处于实验阶段，请谨慎使用。
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleAccept} variant="default">
            我已了解，继续使用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const DisclaimerDialog = defineModal<void, 'accepted' | void>(
  DisclaimerDialogImpl
);
