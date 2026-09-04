import { useEffect } from 'react';

import { ProviderBindConfirmDialog } from '@/components/dialogs/global/ProviderBindConfirmDialog';
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
 * The backend broadcasts to every webview, so more than one window may raise
 * the prompt. The Host resolves only the first answer and reports `false` for
 * the rest, so a losing window just closes its dialog.
 */
export function useProviderBindConfirmations() {
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
          await createPluginControlApi(transport).resolveProviderBind(
            request.requestId,
            approved === true
          );
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
  }, [transport]);
}
