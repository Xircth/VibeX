import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
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
import { openInSystemBrowser } from '@/hooks/useOpenLink';
import { cn } from '@/lib/utils';

import { SettingsActionBar, SettingsSection } from './SettingsUi';
import { DevicePairingPanel } from './DevicePairingPanel';
import { HostTunnelPanel } from './HostTunnelPanel';
import { presentRemoteAccess, type RemoteAccessRowKind } from './hostEndpoints';
import { RemoteClientSettings } from './RemoteClientSettings';

type RemoteRoleTab = 'server' | 'client';

const ROLE_TABS: Array<{ value: RemoteRoleTab; labelKey: string }> = [
  { value: 'server', labelKey: 'webService.roleServer' },
  { value: 'client', labelKey: 'webService.roleClient' },
];

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
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [role, setRole] = useState<RemoteRoleTab>('server');
  const hostConsole = transport.environment === 'desktop';
  const serviceRunning = Boolean(status?.running);

  const dirty = useMemo(() => !sameConfig(config, draft), [config, draft]);
  const accessRows = useMemo(
    () =>
      presentRemoteAccess({
        running: Boolean(status?.running),
        servesWebUi: Boolean(status?.serves_web_ui),
        address: status?.address,
        addresses: status?.addresses,
        reachability: status?.reachability,
        windowOrigin: window.location.origin,
      }),
    [status]
  );

  const hasSeparateBrowser = accessRows.some((row) => row.kind === 'browser');
  const addressCopy: Record<
    RemoteAccessRowKind,
    { label: string; description: string }
  > = {
    browser: {
      label: t('webService.browserAddressLabel'),
      description: t('webService.browserAddressDescription'),
    },
    thisComputer: {
      label: hasSeparateBrowser
        ? t('webService.hostAddressLabel')
        : t('webService.thisComputerAddressLabel'),
      description: hasSeparateBrowser
        ? t('webService.hostAddressDescription')
        : t('webService.thisComputerAddressDescription'),
    },
    lan: {
      label: t('webService.lanAddressLabel'),
      description: t('webService.lanAddressDescription'),
    },
    published: {
      label: t('webService.publishedAddressLabel'),
      description: t('webService.publishedAddressDescription'),
    },
  };

  const load = useCallback(async () => {
    if (!hostConsole) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [savedConfig, currentStatus] = await Promise.all([
        webServiceApi.getConfig(),
        webServiceApi.getStatus(),
      ]);
      setConfig(savedConfig);
      setDraft(savedConfig);
      const lanMissing =
        currentStatus.running &&
        savedConfig.allow_lan &&
        !(currentStatus.addresses ?? []).some(
          (address) =>
            !address.includes('127.0.0.1') && !address.includes('localhost')
        );
      setStatus(lanMissing ? await webServiceApi.start() : currentStatus);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.configLoadFailed')
      );
    } finally {
      setLoading(false);
    }
  }, [hostConsole, t]);

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
      setStatus(await webServiceApi.getStatus());
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

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      void saveConfig();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [dirty, saveConfig]);

  const startServer = useCallback(async () => {
    if (dirty) {
      await saveConfig();
    }

    setStatusBusy(true);
    try {
      const next = await webServiceApi.start();
      const saved = await webServiceApi.getConfig();
      setConfig(saved);
      setDraft(saved);
      setStatus(next);
      toast.success(t('webService.started'));
      return next;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.startFailed')
      );
      return null;
    } finally {
      setStatusBusy(false);
    }
  }, [dirty, saveConfig, t]);

  const stopServer = useCallback(async () => {
    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.stop());
      toast.success(t('webService.stopped'));
      setProbe(await webServiceApi.probePort(draft.port));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.stopFailed')
      );
    } finally {
      setStatusBusy(false);
    }
  }, [draft.port, t]);

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

  const requireRunning = useCallback(() => {
    if (serviceRunning) return true;
    toast.error(t('webService.enableServiceFirst'));
    return false;
  }, [serviceRunning, t]);

  const generateToken = useCallback(async () => {
    if (!requireRunning()) return;
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
  }, [requireRunning, t]);

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

  const focusRole = (next: RemoteRoleTab) => {
    setRole(next);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-remote-role-tab="${next}"]`)
        ?.focus();
    });
  };

  return (
    <div className="settings-content">
      <div className="chat-channel-heading">
        <div className="chat-channel-heading__copy">
          <h2>
            <Globe aria-hidden="true" />
            <span>{t('webService.title')}</span>
          </h2>
        </div>
        {hostConsole ? (
          <div className="chat-channel-heading__actions">
            <div
              className="chat-channel-tabs"
              role="tablist"
              aria-label={t('webService.roleTabsAria')}
              onKeyDown={(event) => {
                const index = ROLE_TABS.findIndex(
                  (item) => item.value === role
                );
                let next = index;
                if (event.key === 'ArrowRight')
                  next = (index + 1) % ROLE_TABS.length;
                else if (event.key === 'ArrowLeft') {
                  next = (index - 1 + ROLE_TABS.length) % ROLE_TABS.length;
                } else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = ROLE_TABS.length - 1;
                else return;
                event.preventDefault();
                focusRole(ROLE_TABS[next].value);
              }}
            >
              {ROLE_TABS.map((item) => {
                const active = role === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="tab"
                    data-remote-role-tab={item.value}
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    className={active ? 'is-active' : undefined}
                    onClick={() => setRole(item.value)}
                  >
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {role === 'client' && hostConsole ? <RemoteClientSettings /> : null}

      {role === 'server' || !hostConsole ? (
        <div className="settings-sections">
          {hostConsole ? (
            <SettingsSection
              icon={Globe}
              title={t('webService.hostSectionTitle')}
              description={t('webService.hostSectionDescription')}
            >
              <div className="settings-row">
                <div>
                  <Label>{t('webService.currentStatusLabel')}</Label>
                  {serviceRunning ? null : (
                    <p className="settings-row__description">
                      {t('webService.serviceNotStarted')}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'settings-status-lamp',
                      serviceRunning
                        ? 'settings-status-dot-success'
                        : 'settings-status-dot-neutral'
                    )}
                    data-testid="web-service-status-lamp"
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      'rounded-full px-2 py-1 text-sm font-medium',
                      serviceRunning
                        ? 'settings-status-success'
                        : 'text-muted-foreground'
                    )}
                  >
                    {!status
                      ? t('webService.statusUnchecked')
                      : serviceRunning
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
                  <Switch
                    className="settings-switch"
                    checked={serviceRunning}
                    onCheckedChange={(checked: boolean) => {
                      if (checked) {
                        void startServer();
                      } else {
                        void stopServer();
                      }
                    }}
                    disabled={statusBusy}
                    aria-label={
                      serviceRunning
                        ? t('webService.stop')
                        : t('webService.start')
                    }
                  />
                </div>
              </div>

              <div className="settings-row">
                <div>
                  <Label htmlFor="web-service-port">
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
                    className="h-8 shrink-0"
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

              {probe && !probe.available && !serviceRunning ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                  <p className="font-medium">
                    {t('webService.stalePortOccupied', { port: probe.port })}
                  </p>
                  <p className="text-muted-foreground">
                    {t('webService.stalePortHint')}
                  </p>
                </div>
              ) : probe ? (
                <p className="settings-row__description">
                  {t('webService.portProbeResult', {
                    port: probe.port,
                    result: probe.available
                      ? t('webService.available')
                      : probe.message,
                  })}
                </p>
              ) : null}

              <div className="settings-row">
                <div>
                  <Label htmlFor="web-service-autostart">
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
                  <Label htmlFor="web-service-lan">
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

              <HostTunnelPanel
                serviceRunning={serviceRunning}
                onReachabilityChange={() => void refreshStatus()}
              />
            </SettingsSection>
          ) : null}

          <DevicePairingPanel
            transport={transport}
            hostId={status?.host_id}
            hostUrls={
              status?.addresses && status.addresses.length > 0
                ? status.addresses
                : status?.address
                  ? [status.address]
                  : []
            }
            reachability={status?.reachability ?? []}
            listenAddresses={status?.listen_addresses ?? []}
            serviceRunning={serviceRunning}
          />

          {hostConsole ? (
            <SettingsSection
              icon={Shield}
              title={t('webService.webSectionTitle')}
              description={t('webService.webSectionDescription')}
              className={!serviceRunning ? 'settings-remote-gated' : undefined}
            >
              <div className="settings-row">
                <div>
                  <Label>{t('webService.tokenLabel')}</Label>
                  <p className="settings-row__description">
                    {t('webService.tokenDescription')}
                  </p>
                </div>
                <div className="flex w-full max-w-sm gap-2">
                  <Input
                    type={tokenRevealed ? 'text' : 'password'}
                    value={draft.token ?? ''}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        token: event.target.value || null,
                      }))
                    }
                    placeholder={t('webService.tokenPlaceholder')}
                    className="font-mono"
                    autoComplete="off"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0"
                    onClick={() => {
                      if (!requireRunning()) return;
                      setTokenRevealed((value) => !value);
                    }}
                    title={
                      tokenRevealed
                        ? t('webService.hideToken')
                        : t('webService.showToken')
                    }
                    aria-label={
                      tokenRevealed
                        ? t('webService.hideToken')
                        : t('webService.showToken')
                    }
                  >
                    {tokenRevealed ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0"
                    onClick={() => {
                      if (!requireRunning() || !draft.token) return;
                      void copyText(draft.token, 'Token');
                    }}
                    disabled={!draft.token}
                    title={t('webService.copyToken')}
                    aria-label={t('webService.copyToken')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => void generateToken()}
                    disabled={saving}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    {t('webService.generate')}
                  </Button>
                </div>
              </div>

              {accessRows.length === 0 ? (
                <p className="settings-row__description">
                  {t('webService.serviceNotStarted')}
                </p>
              ) : (
                accessRows.map((row) => {
                  const copy = addressCopy[row.kind];
                  return (
                    <div
                      className="settings-row"
                      key={`${row.kind}:${row.origin}`}
                    >
                      <div>
                        <Label>{copy.label}</Label>
                        <p className="settings-row__description font-mono">
                          {row.origin}
                        </p>
                        <p className="settings-row__description">
                          {copy.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => {
                            if (!requireRunning()) return;
                            void copyText(
                              row.origin,
                              t('webService.copyOrigin')
                            );
                          }}
                          aria-label={`${t('webService.copyOrigin')} ${row.origin}`}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          onClick={() => {
                            if (!requireRunning()) return;
                            void openInSystemBrowser(row.openHref);
                          }}
                        >
                          <ExternalLink className="mr-1 h-3.5 w-3.5" />
                          {t('webService.openOrigin')}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </SettingsSection>
          ) : null}
        </div>
      ) : null}

      {role === 'server' ? (
        <SettingsActionBar
          dirty={dirty}
          saving={saving}
          onDiscard={discard}
          onSave={() => void saveConfig()}
          disabled={saving}
          message={t('webService.actionBarMessage')}
        />
      ) : null}
    </div>
  );
}
