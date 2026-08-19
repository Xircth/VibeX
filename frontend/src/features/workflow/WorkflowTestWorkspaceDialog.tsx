import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Workspace } from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CREATE_NEW = 'create-new';

export function WorkflowTestWorkspaceDialog({
  open,
  workspaces,
  defaultWorkspaceId,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  workspaces: Workspace[];
  defaultWorkspaceId?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    choice: { kind: 'existing'; id: string } | { kind: 'new' }
  ) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const fallbackId = workspaces[0]?.id ?? CREATE_NEW;
  const [value, setValue] = useState(
    defaultWorkspaceId &&
      workspaces.some((item) => item.id === defaultWorkspaceId)
      ? defaultWorkspaceId
      : fallbackId
  );

  useEffect(() => {
    if (!open) return;
    setValue(
      defaultWorkspaceId &&
        workspaces.some((item) => item.id === defaultWorkspaceId)
        ? defaultWorkspaceId
        : (workspaces[0]?.id ?? CREATE_NEW)
    );
  }, [defaultWorkspaceId, open, workspaces]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{t('automations.chooseTestWorkspace')}</DialogTitle>
        <DialogDescription>
          {t('automations.chooseTestWorkspaceDescription')}
        </DialogDescription>
      </DialogHeader>
      <DialogContent>
        <div className="space-y-1.5">
          <Label>{t('automations.testWorkspace')}</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name?.trim() || workspace.branch}
                </SelectItem>
              ))}
              <SelectItem value={CREATE_NEW}>
                {t('automations.createTestWorktreeOption')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('automations.cancel')}
        </Button>
        <Button
          onClick={() =>
            onConfirm(
              value === CREATE_NEW
                ? { kind: 'new' }
                : { kind: 'existing', id: value }
            )
          }
        >
          {t('automations.useSelectedWorktree')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
