import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { useTranslation } from 'react-i18next';
import { APP_NAME } from '@/lib/branding';
import { defineModal, type NoProps } from '@/lib/modals';

const BetaWorkspacesDialogImpl = NiceModal.create<NoProps>(() => {
  const modal = useModal();
  const { t } = useTranslation(['dialogs', 'common']);

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
          alt={t('betaWorkspaces.title')}
          className="w-full rounded-lg border"
        />
        <DialogHeader>
          <DialogTitle className="text-xl">
            {t('betaWorkspaces.title')}
          </DialogTitle>
        </DialogHeader>
        <div className="text-muted-foreground space-y-4">
          <p>{t('betaWorkspaces.intro', { appName: APP_NAME })}</p>
          <p>{t('betaWorkspaces.description')}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('betaWorkspaces.newFeatureEditRepos')}</li>
            <li>{t('betaWorkspaces.newFeatureMultipleAgents')}</li>
            <li>{t('betaWorkspaces.newFeatureCommandBar')}</li>
          </ul>
          <p>{t('betaWorkspaces.remainingIntro')}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('betaWorkspaces.remainingBoard')}</li>
            <li>{t('betaWorkspaces.remainingSettings')}</li>
            <li>{t('betaWorkspaces.remainingProjects')}</li>
          </ul>
          <p>{t('betaWorkspaces.transition')}</p>
          <p>{t('betaWorkspaces.optOut')}</p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleMaybeLater}>
            {t('betaWorkspaces.maybeLater')}
          </Button>
          <Button onClick={handleJoinBeta}>
            {t('betaWorkspaces.joinBeta')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const BetaWorkspacesDialog = defineModal<void, boolean>(
  BetaWorkspacesDialogImpl
);
