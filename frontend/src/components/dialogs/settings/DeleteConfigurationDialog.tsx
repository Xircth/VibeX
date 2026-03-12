import { useState } from 'react';import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/lib/modals';

export interface DeleteConfigurationDialogProps {
  configName: string;
  executorType: string;
}

export type DeleteConfigurationResult = 'deleted' | 'canceled';

const DeleteConfigurationDialogImpl =
  NiceModal.create<DeleteConfigurationDialogProps>(
    ({ configName, executorType }) => {      const modal = useModal();
      const [isDeleting, setIsDeleting] = useState(false);
      const [error, setError] = useState<string | null>(null);

      const handleDelete = async () => {
        setIsDeleting(true);
        setError(null);

        try {
          // Resolve with 'deleted' to let parent handle the deletion
          modal.resolve('deleted' as DeleteConfigurationResult);
          modal.hide();
        } catch {
          setError('Failed to delete configuration. Please try again.');
        } finally {
          setIsDeleting(false);
        }
      };

      const handleCancel = () => {
        modal.resolve('canceled' as DeleteConfigurationResult);
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
              <DialogTitle>
                {'删除配置？'}
              </DialogTitle>
              <DialogDescription>
                {`这将从 ${executorType} 执行器中永久删除"${configName}"。此操作无法撤销。`}
              </DialogDescription>
            </DialogHeader>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={isDeleting}
              >
                {'取消'}
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {'删除'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    }
  );

export const DeleteConfigurationDialog = defineModal<
  DeleteConfigurationDialogProps,
  DeleteConfigurationResult
>(DeleteConfigurationDialogImpl);
