import { ExternalLink, KeyRound, Loader2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OpenCodeProviderConnectionView } from 'shared/types';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

type PackageId = 'opencode' | 'opencode-go';

const PACKAGES: {
  id: PackageId;
  name: string;
  url: string;
}[] = [
  { id: 'opencode', name: 'Zen', url: 'https://opencode.ai/auth' },
  { id: 'opencode-go', name: 'Go', url: 'https://opencode.ai/auth' },
];

type Props = {
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

export function OpenCodeSubscriptionPanel({ onChanged, onDirtyChange }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [providers, setProviders] = useState<OpenCodeProviderConnectionView[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<Record<PackageId, string>>({
    opencode: '',
    'opencode-go': '',
  });
  const [saving, setSaving] = useState<PackageId | null>(null);
  const dirty = Object.values(keys).some((value) => value.trim().length > 0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await agentManagementApi.openCodeProviders();
      setProviders(
        view.providers.filter(
          (provider) =>
            provider.provider_id === 'opencode' ||
            provider.provider_id === 'opencode-go'
        )
      );
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.openCodeProviderLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const connect = async (pack: (typeof PACKAGES)[number]) => {
    const apiKey = keys[pack.id].trim();
    if (!apiKey) {
      toast.warning(t('settings:agents.openCodeProviderRequired'));
      return;
    }
    setSaving(pack.id);
    try {
      const view = await agentManagementApi.connectOpenCodeProvider({
        provider_id: pack.id,
        name: pack.id === 'opencode' ? 'OpenCode Zen' : 'OpenCode Go',
        npm: null,
        api: null,
        base_url: null,
        api_key: apiKey,
        models: [],
        enabled: true,
      });
      setProviders(
        view.providers.filter(
          (provider) =>
            provider.provider_id === 'opencode' ||
            provider.provider_id === 'opencode-go'
        )
      );
      setKeys((current) => ({ ...current, [pack.id]: '' }));
      toast.success(
        t('settings:agents.openCodeProviderConnected', { name: pack.name })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.openCodeProviderConnectFailed'))
      );
    } finally {
      setSaving(null);
    }
  };

  const disconnect = async (pack: (typeof PACKAGES)[number]) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.openCodeProviderDisconnectTitle', {
        name: pack.name,
      }),
      message: t('settings:agents.openCodeProviderDisconnectMessage'),
      confirmText: t('settings:agents.openCodeProviderDisconnectConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setSaving(pack.id);
    try {
      const view = await agentManagementApi.disconnectOpenCodeProvider(pack.id);
      setProviders(
        view.providers.filter(
          (provider) =>
            provider.provider_id === 'opencode' ||
            provider.provider_id === 'opencode-go'
        )
      );
      toast.success(
        t('settings:agents.openCodeProviderDisconnected', { name: pack.name })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          t('settings:agents.openCodeProviderDisconnectFailed')
        )
      );
    } finally {
      setSaving(null);
    }
  };

  return (
    <ul className="agent-opencode-plans">
      {PACKAGES.map((pack) => {
        const connected = providers.find(
          (provider) => provider.provider_id === pack.id
        );
        return (
          <li key={pack.id}>
            <div>
              <strong>{pack.name}</strong>
              <span>
                {loading
                  ? t('settings:agents.openCodeProviderLoading')
                  : connected?.credential_present
                    ? t('settings:agents.credentialPresent')
                    : t('settings:agents.credentialMissing')}
              </span>
            </div>
            <div className="agent-opencode-plan-actions">
              <Button
                className="h-8"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void (async () => {
                    try {
                      const { open } = await import('@tauri-apps/plugin-shell');
                      await open(pack.url);
                    } catch {
                      window.open(pack.url, '_blank', 'noopener,noreferrer');
                    }
                  })();
                }}
              >
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                {t('settings:agents.openOfficialPage')}
              </Button>
              {connected?.credential_present ? (
                <Button
                  className="h-8"
                  disabled={saving !== null}
                  size="sm"
                  variant="ghost"
                  onClick={() => void disconnect(pack)}
                >
                  {saving === pack.id ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : (
                    <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {t('settings:agents.disconnect')}
                </Button>
              ) : (
                <label className="agent-opencode-plan-key">
                  <span className="sr-only">{pack.name} API Key</span>
                  <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                  <input
                    autoComplete="new-password"
                    disabled={saving !== null}
                    name={`${pack.id}_api_key`}
                    placeholder={t('settings:agents.apiKeyPlaceholder')}
                    type="password"
                    value={keys[pack.id]}
                    onChange={(event) =>
                      setKeys((current) => ({
                        ...current,
                        [pack.id]: event.target.value,
                      }))
                    }
                  />
                  <Button
                    className="h-8"
                    disabled={saving !== null || !keys[pack.id].trim()}
                    size="sm"
                    onClick={() => void connect(pack)}
                  >
                    {saving === pack.id ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                      />
                    ) : null}
                    {t('settings:agents.connect')}
                  </Button>
                </label>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
