import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { APP_NAME } from '@/lib/branding';
import { defineModal, type NoProps } from '@/lib/modals';

const BetaWorkspacesDialogImpl = NiceModal.create<NoProps>(() => {
  const modal = useModal();

  const handleJoinBeta = () => {
    modal.resolve(true);
  };

  const handleMaybeLater = () => {
    modal.resolve(false);
  };

  return (
    <Dialog open={modal.visible} uncloseable>
      <DialogContent className="sm:max-w-[640px]">
        <img
          src="/beta-workspaces-preview.png"
          alt={'试用新界面'}
          className="w-full rounded-lg border"
        />
        <DialogHeader>
          <DialogTitle className="text-xl">{'试用新界面'}</DialogTitle>
        </DialogHeader>
        <div className="text-muted-foreground space-y-4">
          <p>{`我们从头重建了 ${APP_NAME} 的界面，您已被邀请试用。`}</p>
          <p>
            {
              '新界面针对日常工作进行了优化：管理代理、预览更改和审查代码。它还解锁了旧界面中不可用的功能：'
            }
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>{'同时编辑多个仓库'}</li>
            <li>{'在单个工作区中运行多个代理对话（甚至跨不同代理）'}</li>
            <li>{'使用命令栏更快地导航'}</li>
          </ul>
          <p>{'目前，一些功能仍保留在当前界面中：'}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{'在看板上管理任务'}</li>
            <li>{'更改设置'}</li>
            <li>{'管理项目'}</li>
          </ul>
          <p>{'在接下来几周的过渡期内，您将可以在两个界面之间切换。'}</p>
          <p>{'想要退出？您可以随时在设置中切换回当前界面。'}</p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleMaybeLater}>
            {'稍后再说'}
          </Button>
          <Button onClick={handleJoinBeta}>{'加入 Beta'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const BetaWorkspacesDialog = defineModal<void, boolean>(
  BetaWorkspacesDialogImpl
);
