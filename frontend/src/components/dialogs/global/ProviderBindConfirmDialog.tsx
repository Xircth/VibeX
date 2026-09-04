import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { Plug } from 'lucide-react';
import { useState } from 'react';
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
import { defineModal } from '@/lib/modals';

export type ProviderBindConfirmDialogProps = {
  pluginName: string;
  agentId: string;
  /** Absent means the plugin wants to unbind the agent. */
  presetName?: string | null;
  apiUrl?: string | null;
  /** Plugin-supplied justification, rendered as plain text. */
  reason?: string | null;
};

const ProviderBindConfirmDialogImpl =
  NiceModal.create<ProviderBindConfirmDialogProps>(
    ({ pluginName, agentId, presetName, apiUrl, reason }) => {
      const modal = useModal();
      const { t } = useTranslation(['dialogs', 'common']);
      const [decided, setDecided] = useState(false);
      const unbinding = !presetName;

      const decide = (approved: boolean) => {
        setDecided(true);
        modal.resolve(approved);
        modal.hide();
      };

      return (
        <Dialog
          open={modal.visible}
          onOpenChange={(open) => {
            // Dismissing the dialog is a refusal, not a silent no-op — the
            // plugin's Worker is parked waiting for this answer.
            if (!open && !decided) decide(false);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Plug className="h-4 w-4" />
                {t('providerBind.title')}
              </DialogTitle>
              <DialogDescription>
                {unbinding
                  ? t('providerBind.describeUnbind', {
                      plugin: pluginName,
                      agentId,
                    })
                  : t('providerBind.describeBind', {
                      plugin: pluginName,
                      agentId,
                      preset: presetName,
                    })}
              </DialogDescription>
            </DialogHeader>

            {apiUrl ? (
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <div className="text-xs text-muted-foreground">
                  {t('providerBind.endpoint')}
                </div>
                <div className="break-all font-mono text-xs text-foreground">
                  {apiUrl}
                </div>
              </div>
            ) : null}

            {reason ? (
              <p className="text-xs text-muted-foreground">
                {t('providerBind.reason', { reason })}
              </p>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {t('providerBind.effect')}
            </p>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => decide(false)}>
                {t('common:cancel')}
              </Button>
              <Button onClick={() => decide(true)}>
                {unbinding
                  ? t('providerBind.confirmUnbind')
                  : t('providerBind.confirmBind')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    }
  );

export const ProviderBindConfirmDialog = defineModal<
  ProviderBindConfirmDialogProps,
  boolean
>(ProviderBindConfirmDialogImpl);
