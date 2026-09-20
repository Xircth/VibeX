import type { Project } from 'shared/types';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import i18n from '@/i18n';
import { projectsApi } from '@/lib/api';

export async function initProjectGitWithPrompt(
  project: Pick<Project, 'id' | 'name' | 'is_git'>
): Promise<Project | null> {
  if (project.is_git) {
    return null;
  }

  const children = await projectsApi.gitChildren(project.id);
  if (children.length > 0) {
    const confirmed = await ConfirmDialog.show({
      title: i18n.t('projectForm.nestedGitConfirmTitle', { ns: 'dialogs' }),
      message: i18n.t('projectForm.nestedGitConfirmMessage', { ns: 'dialogs' }),
      confirmText: i18n.t('projectForm.nestedGitConfirmAction', {
        ns: 'dialogs',
      }),
      cancelText: i18n.t('cancel', { ns: 'common' }),
    });
    if (confirmed !== 'confirmed') {
      return null;
    }
  }

  try {
    const updated = await projectsApi.initGit(project.id);
    toast.success(
      i18n.t('projectRail.initGitSuccess', {
        ns: 'panels',
        name: project.name,
      })
    );
    return updated;
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : i18n.t('projectRail.initGitFailed', { ns: 'panels' })
    );
    return null;
  }
}
