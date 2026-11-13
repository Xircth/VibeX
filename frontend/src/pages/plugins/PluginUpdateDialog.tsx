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
import { toast } from '@/components/ui/toast';
import {
  createPluginControlApi,
  type PluginUpdatePreview,
} from '@/lib/api/plugins';
import { getInvokeErrorMessage } from '@/lib/errors';

export function usePluginUpdateConfirmation(
  api: ReturnType<typeof createPluginControlApi>,
  onUpdated: () => Promise<void>
) {
  const { t } = useTranslation('settings');
  const [preview, setPreview] = useState<PluginUpdatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepare = async (pluginId: string) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.prepareUpdate(pluginId));
    } catch (cause) {
      toast.error(t('plugins.updateFailed'), {
        description: getInvokeErrorMessage(cause),
      });
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmUpdate(preview.plugin.id, preview.confirmationId);
      setPreview(null);
      await onUpdated();
      toast.success(t('plugins.updated'));
    } catch (cause) {
      setError(getInvokeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return {
    preview,
    busy,
    error,
    prepare,
    confirm,
    cancel: () => {
      if (!busy) {
        setPreview(null);
        setError(null);
      }
    },
  };
}

export function PluginUpdateDialog({
  preview,
  busy,
  error,
  confirm,
  cancel,
}: ReturnType<typeof usePluginUpdateConfirmation>) {
  const { t } = useTranslation(['settings', 'common']);
  return (
    <Dialog
      open={Boolean(preview)}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('plugins.updatePreviewTitle')}</DialogTitle>
          <DialogDescription>{t('plugins.fullTrustConfirm')}</DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="min-w-0 space-y-3">
            <p className="font-medium">{preview.plugin.name}</p>
            <p className="break-all text-sm text-muted-foreground">
              {preview.plugin.publisher}/{preview.plugin.id}
            </p>
            {preview.plugin.description ? (
              <p className="text-sm">{preview.plugin.description}</p>
            ) : null}
            <ul className="text-sm">
              {preview.plugin.hasWorker ? <li>Worker</li> : null}
              {(preview.plugin.mcpServers ?? []).map((id) => (
                <li key={id}>MCP: {id}</li>
              ))}
              {(preview.plugin.appContributions ?? []).map((app) => (
                <li key={app.id}>{app.label}</li>
              ))}
              {(preview.plugin.skills ?? []).map((skill) => (
                <li key={skill.id}>{skill.id}</li>
              ))}
            </ul>
            <p className="tabular-nums">
              {preview.currentVersion} → {preview.targetVersion}
            </p>
            <dl className="space-y-2 text-sm">
              <div>
                <dt>{t('plugins.installPreviewSourceLabel')}</dt>
                <dd className="break-all">
                  {preview.source.origin} @ {preview.source.tag}
                </dd>
              </div>
              <div>
                <dt>{t('plugins.packageDigest')}</dt>
                <dd className="break-all font-mono text-xs">
                  {preview.packageDigest}
                </dd>
              </div>
            </dl>
            {preview.releaseNotes ? (
              <div>
                <p className="font-medium">{t('plugins.releaseNotes')}</p>
                <p className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">
                  {preview.releaseNotes}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={cancel}>
            {t('common:cancel')}
          </Button>
          <Button
            disabled={busy || Boolean(error)}
            onClick={() => void confirm()}
          >
            {t(busy ? 'plugins.updating' : 'plugins.confirmUpdate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
