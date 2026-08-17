import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  Shield,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import type { BackendTransport } from '@/lib/backendTransport';
import { useBackendTransport } from '@/lib/transport';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  type PortProbeResult,
  type WebServerStatus,
  type WebServiceConfig,
  webServiceApi,
} from '@/lib/api';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';

import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './SettingsUi';
import { DevicePairingPanel } from './DevicePairingPanel';

const DEFAULT_CONFIG: WebServiceConfig = {
  port: 17891,
  token: null,
  auto_start: false,
  allow_lan: false,
};

function sameConfig(a: WebServiceConfig, b: WebServiceConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function WebServiceSettings({
  transport: transportOverride,
}: {
  transport?: BackendTransport;
} = {}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const { t } = useTranslation(['settings', 'common']);
  const [config, setConfig] = useState<WebServiceConfig>(DEFAULT_CONFIG);
  const [draft, setDraft] = useState<WebServiceConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [probe, setProbe] = useState<PortProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [probing, setProbing] = useState(false);

  const dirty = useMemo(() => !sameConfig(config, draft), [config, draft]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [savedConfig, currentStatus] = await Promise.all([
        webServiceApi.getConfig(),
        webServiceApi.getStatus(),
      ]);
      setConfig(savedConfig);
      setDraft(savedConfig);
      setStatus(currentStatus);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.configLoadFailed')
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const reloadFromJson = () => {
      if (!dirty) void load();
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, reloadFromJson);
    return () =>
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reloadFromJson);
  }, [dirty, load]);

  const refreshStatus = useCallback(async () => {
    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.getStatus());
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.statusLoadFailed')
      );
    } finally {
      setStatusBusy(false);
    }
  }, [t]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await webServiceApi.updateConfig(draft);
      setConfig(saved);
      setDraft(saved);
      setProbe(null);
      toast.success(t('webService.configSaved'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.configSaveFailed')
      );
    } finally {
      setSaving(false);
    }
  }, [draft, t]);

  const discard = useCallback(() => {
    setDraft(config);
    setProbe(null);
  }, [config]);

  const startServer = useCallback(async () => {
    if (dirty) {
      toast.error(t('webService.saveBeforeStart'));
      return;
    }

    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.start());
      toast.success(t('webService.started'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.startFailed')
      );
    } finally {
      setStatusBusy(false);
    }
  }, [dirty, t]);

  const stopServer = useCallback(async () => {
    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.stop());
      toast.success(t('webService.stopped'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.stopFailed')
      );
    } finally {
      setStatusBusy(false);
    }
  }, [t]);

  const probePort = useCallback(async () => {
    setProbing(true);
    try {
      const result = await webServiceApi.probePort(draft.port);
      setProbe(result);
      toast[result.available ? 'success' : 'error'](
        result.available
          ? t('webService.portAvailable')
          : (result.message ?? t('webService.portUnavailable'))
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.probeFailed')
      );
    } finally {
      setProbing(false);
    }
  }, [draft.port, t]);

  const generateToken = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await webServiceApi.generateToken();
      setConfig(saved);
      setDraft((previous) => ({ ...previous, token: saved.token }));
      toast.success(t('webService.tokenGenerated'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.tokenGenerateFailed')
      );
    } finally {
      setSaving(false);
    }
  }, [t]);

  const copyText = useCallback(
    async (text: string, label: string) => {
      await navigator.clipboard.writeText(text);
      toast.success(t('webService.copied', { label }));
    },
    [t]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title={t('webService.title')}
        description={t('webService.description')}
      />

      <div className="settings-sections">
        <DevicePairingPanel transport={transport} />

        <SettingsSection
          icon={Globe}
          title={t('webService.statusSectionTitle')}
          description={t('webService.statusSectionDescription')}
        >
          <div className="settings-row">
            <div>
              <Label className="text-xs">
                {t('webService.currentStatusLabel')}
              </Label>
              <p className="settings-row__description">
                {status?.address ?? t('webService.serviceNotStarted')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-1 text-xs font-medium ${
                  status?.running
                    ? 'settings-status-success'
                    : 'text-muted-foreground'
                }`}
              >
                {!status
                  ? t('webService.statusUnchecked')
                  : status.running
                    ? t('webService.statusRunning')
                    : t('webService.statusStopped')}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => void refreshStatus()}
                disabled={statusBusy}
                title={t('webService.refreshStatus')}
                aria-label={t('webService.refreshStatus')}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${statusBusy ? 'animate-spin' : ''}`}
                />
              </Button>
              {status?.address ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => window.open(status.address!, '_blank')}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  {t('webService.open')}
                </Button>
              ) : null}
              <Switch
                className="settings-switch"
                checked={Boolean(status?.running)}
                onCheckedChange={(checked: boolean) => {
                  if (checked) {
                    void startServer();
                  } else {
                    void stopServer();
                  }
                }}
                disabled={statusBusy}
                aria-label={
                  status?.running ? t('webService.stop') : t('webService.start')
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Shield}
          title={t('webService.accessSectionTitle')}
          description={t('webService.accessSectionDescription')}
        >
          <div className="settings-row">
            <div>
              <Label htmlFor="web-service-port" className="text-xs">
                {t('webService.portLabel')}
              </Label>
              <p className="settings-row__description">
                {t('webService.portDescription')}
              </p>
            </div>
            <div className="flex w-full max-w-xs gap-2">
              <Input
                id="web-service-port"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    port: Number(event.target.value),
                  }))
                }
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void probePort()}
                disabled={probing}
              >
                {probing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t('webService.probe')}
              </Button>
            </div>
          </div>

          {probe ? (
            <div className="px-4 pb-3 text-[11px] text-muted-foreground">
              {t('webService.portProbeResult', {
                port: probe.port,
                result: probe.available
                  ? t('webService.available')
                  : probe.message,
              })}
            </div>
          ) : null}

          <div className="settings-row">
            <div>
              <Label htmlFor="web-service-autostart" className="text-xs">
                {t('webService.autoStartLabel')}
              </Label>
              <p className="settings-row__description">
                {t('webService.autoStartDescription')}
              </p>
            </div>
            <Switch
              id="web-service-autostart"
              className="settings-switch"
              checked={draft.auto_start}
              onCheckedChange={(checked: boolean) =>
                setDraft((previous) => ({
                  ...previous,
                  auto_start: checked,
                }))
              }
            />
          </div>

          <div className="settings-row">
            <div>
              <Label htmlFor="web-service-lan" className="text-xs">
                {t('webService.allowLanLabel')}
              </Label>
              <p className="settings-row__description">
                {t('webService.allowLanDescription')}
              </p>
            </div>
            <Switch
              id="web-service-lan"
              className="settings-switch"
              checked={Boolean(draft.allow_lan)}
              onCheckedChange={(checked: boolean) =>
                setDraft((previous) => ({
                  ...previous,
                  allow_lan: checked,
                }))
              }
            />
          </div>

          <div className="settings-row">
            <div>
              <Label className="text-xs">{t('webService.tokenLabel')}</Label>
              <p className="settings-row__description">
                {t('webService.tokenDescription')}
              </p>
            </div>
            <div className="flex w-full max-w-sm gap-2">
              <Input
                type="password"
                readOnly
                value={draft.token ?? ''}
                placeholder={t('webService.tokenPlaceholder')}
                className="font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={() =>
                  draft.token ? void copyText(draft.token, 'Token') : undefined
                }
                disabled={!draft.token}
                title={t('webService.copyToken')}
                aria-label={t('webService.copyToken')}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void generateToken()}
                disabled={saving}
              >
                <KeyRound className="mr-1 h-3.5 w-3.5" />
                {t('webService.generate')}
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={discard}
        onSave={() => void saveConfig()}
        disabled={saving}
        message={t('webService.actionBarMessage')}
      />
    </div>
  );
}
