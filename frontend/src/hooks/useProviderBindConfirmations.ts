import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderBindConfirmDialog } from '@/components/dialogs/global/ProviderBindConfirmDialog';
import { toast } from '@/components/ui/toast';
import { backendListen } from '@/lib/backendTransport';
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
 * The prompt is a Host Event, so local App and bound windows share one path.
 */
export function useProviderBindConfirmations() {
  const { t } = useTranslation('dialogs');
  const transport = useBackendTransport();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void backendListen<unknown>(PROVIDER_BIND_CONFIRM, (payload) => {
      if (!isConfirmation(payload)) return;
      const request = payload;
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
        if (approved === true && !accepted) {
          toast.error(t('providerBind.expired'));
        }
      })();
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t, transport]);
}
