import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function UnnamedTaskNameDialog({
  open,
  name,
  error,
  showDiscard,
  onNameChange,
  onDiscard,
  onRename,
  onCancel,
}: {
  open: boolean;
  name: string;
  error: string | null;
  showDiscard: boolean;
  onNameChange: (name: string) => void;
  onDiscard: () => void;
  onRename: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('workflow');

  return (
    <Dialog
      open={open}
      uncloseable={showDiscard}
      onOpenChange={(next) => {
        if (!next && !showDiscard) onCancel?.();
      }}
    >
      <DialogContent
        data-testid="unnamed-task-name-dialog"
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t('studio.unnamedTaskTitle')}</DialogTitle>
          <DialogDescription>{t('studio.unnamedTaskBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="unnamed-task-name-input">
            {t('studio.unnamedTaskNameLabel')}
          </Label>
          <Input
            id="unnamed-task-name-input"
            data-testid="unnamed-task-name-input"
            value={name}
            autoFocus
            placeholder={t('studio.taskNamePlaceholder')}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onRename();
              }
            }}
          />
          {error ? (
            <p
              role="alert"
              data-testid="unnamed-task-name-error"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {showDiscard ? (
            <Button
              type="button"
              variant="outline"
              data-testid="unnamed-task-discard-btn"
              onClick={onDiscard}
            >
              {t('studio.unnamedTaskDiscard')}
            </Button>
          ) : null}
          <Button
            type="button"
            data-testid="unnamed-task-rename-btn"
            onClick={onRename}
          >
            {t('studio.unnamedTaskRename')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
