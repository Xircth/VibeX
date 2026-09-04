import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderBindConfirmDialog } from '@/components/dialogs/global/ProviderBindConfirmDialog';
import { toast } from '@/components/ui/toast';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

const PROVIDER_BIND_CONFIRM = 'provider-bind-confirm';

interface ProviderBindConfirmation {
  requestId: string;
  pluginId: string;
  pluginName: string;
  agentId: string;
  presetId: string | null;
  presetName: string | null;
  apiUrl: string | null;
  reason: string | null;
}

function isConfirmation(value: unknown): value is ProviderBindConfirmation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string' &&
    typeof record.pluginId === 'string' &&
    typeof record.agentId === 'string'
  );
}

/**
 * Shows the Host confirmation a plugin's `provider.presets.bind` is parked on.
 *
 * The Host addresses this to the main window only, so exactly one dialog can
 * appear per request. It also stops waiting after a few minutes, which is why
 * an approval can still come back rejected.
 */
export function useProviderBindConfirmations() {
  const { t } = useTranslation('dialogs');
  const transport = useBackendTransport();

  useEffect(() => {
    if (transport.environment !== 'desktop') return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen(PROVIDER_BIND_CONFIRM, (event) => {
        if (!isConfirmation(event.payload)) return;
        const request = event.payload;
        void (async () => {
          const approved = await ProviderBindConfirmDialog.show({
            pluginName: request.pluginName || request.pluginId,
            agentId: request.agentId,
            presetName: request.presetName,
            apiUrl: request.apiUrl,
            reason: request.reason,
          });
          ProviderBindConfirmDialog.remove();
          const accepted = await createPluginControlApi(
            transport
          ).resolveProviderBind(request.requestId, approved === true);
          // The Host had already given up waiting. Saying nothing would leave
          // the user believing the bind went through.
          if (approved === true && !accepted) {
            toast.error(t('providerBind.expired'));
          }
        })();
      });
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t, transport]);
}
