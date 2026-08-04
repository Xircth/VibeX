import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { worktreeSettingsApi } from '@/lib/api';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export async function confirmWorktreeCreation(
  projectId: string,
  t: Translate
): Promise<boolean> {
  const status = await worktreeSettingsApi.getCleanupStatus(projectId);
  if (!status.should_prompt) return true;

  const result = await ConfirmDialog.show({
    title: t('settings:worktrees.cleanupConfirmTitle'),
    message: t('settings:worktrees.cleanupConfirmMessage', {
      count: status.current_count,
      threshold: status.threshold,
    }),
    confirmText: t('settings:worktrees.continueCreating'),
    cancelText: t('settings:worktrees.cancelCreating'),
    variant: 'info',
  });
  return result === 'confirmed';
}
