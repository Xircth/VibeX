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
import { Alert } from '@/components/ui/alert';
import { tasksApi } from '@/lib/api';
import type { TaskWithAttemptStatus } from 'shared/types';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/lib/modals';

export interface ClearDoneTasksConfirmationDialogProps {
  tasks: TaskWithAttemptStatus[];
}

const ClearDoneTasksConfirmationDialogImpl =
  NiceModal.create<ClearDoneTasksConfirmationDialogProps>(({ tasks }) => {
    const modal = useModal();
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const taskCount = tasks.length;
    const taskLabel = taskCount === 1 ? 'task' : 'tasks';

    const handleConfirmDelete = async () => {
      if (taskCount === 0) {
        modal.resolve();
        modal.hide();
        return;
      }

      setIsDeleting(true);
      setError(null);

      try {
        for (const task of tasks) {
          await tasksApi.delete(task.id);
        }

        modal.resolve();
        modal.hide();
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error
            ? err.message
            : `Failed to delete ${taskLabel} from Done`;
        setError(errorMessage);
      } finally {
        setIsDeleting(false);
      }
    };

    const handleCancelDelete = () => {
      modal.reject();
      modal.hide();
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => !open && handleCancelDelete()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear Done Tasks</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete all{' '}
              <span className="font-semibold">{taskCount}</span> {taskLabel} in
              the <span className="font-semibold">"Done"</span> column?
            </DialogDescription>
          </DialogHeader>

          <Alert variant="destructive" className="mb-4">
            <strong>Warning:</strong> This action will permanently delete these
            tasks and cannot be undone.
          </Alert>

          {error && (
            <Alert variant="destructive" className="mb-4">
              {error}
            </Alert>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancelDelete}
              disabled={isDeleting}
              autoFocus
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Clear Done'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  });

export const ClearDoneTasksConfirmationDialog = defineModal<
  ClearDoneTasksConfirmationDialogProps,
  void
>(ClearDoneTasksConfirmationDialogImpl);
