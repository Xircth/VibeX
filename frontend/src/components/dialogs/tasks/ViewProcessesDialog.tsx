import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import { defineModal } from '@/lib/modals';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { WorkspaceActivityPanel } from '@/features/workspace-activity/WorkspaceActivityPanel';

export interface ViewProcessesDialogProps {
  workspaceId?: string;
  sessionId: string | undefined;
  initialProcessId?: string | null;
}

const ViewProcessesDialogImpl = NiceModal.create<ViewProcessesDialogProps>(
  ({ workspaceId, sessionId }) => {
    const modal = useModal();
    const { t } = useTranslation(['dialogs', 'common', 'panels']);

    const handleOpenChange = (open: boolean) => {
      if (!open) {
        modal.hide();
      }
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={handleOpenChange}
        className="max-w-5xl w-[92vw] p-0 overflow-x-hidden"
      >
        <DialogContent
          className="p-0 min-w-0"
          onKeyDownCapture={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              modal.hide();
            }
          }}
        >
          <DialogHeader className="px-4 py-3 border-b">
            <DialogTitle>{t('panels:workspaceActivity.title')}</DialogTitle>
          </DialogHeader>
          <div className="h-[75vh] flex flex-col min-h-0 min-w-0">
            <WorkspaceActivityPanel
              workspaceId={workspaceId}
              sessionId={sessionId}
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);

export const ViewProcessesDialog = defineModal<ViewProcessesDialogProps, void>(
  ViewProcessesDialogImpl
);
