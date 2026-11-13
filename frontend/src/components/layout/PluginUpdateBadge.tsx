import { useEffect } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import { usePluginUpdates } from '@/hooks/usePluginUpdates';
import { openSettingsSurface } from '@/lib/api/settingsWindow';
import { useBackendTransport } from '@/lib/transport';

export function PluginUpdateBadge() {
  const { updates } = usePluginUpdates();
  const transport = useBackendTransport();
  const navigate = useNavigate();
  const { t } = useTranslation('settings');
  const count = updates.filter((item) => item.updateAvailable).length;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void transport
      .listen?.('plugin-updates-available', () => {
        toast.info(t('plugins.updatesAvailable'), {
          id: 'plugin-updates',
          action: {
            label: t('plugins.viewUpdates'),
            onClick: () => openSettingsSurface(navigate, '/plugins'),
          },
        });
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [transport, navigate, t]);
  if (!count) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-secondary"
      onClick={() => openSettingsSurface(navigate, '/plugins')}
      title={t('plugins.updatesAvailable')}
      aria-label={t('plugins.updatesAvailableCount', { count })}
    >
      <ArrowUpCircle className="size-3.5" aria-hidden="true" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}
