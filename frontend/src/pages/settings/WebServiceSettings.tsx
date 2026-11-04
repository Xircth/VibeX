import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  CheckCircle2,
  CircleAlert,
  Globe,
  Laptop,
  Loader2,
  Server,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import type { BackendTransport } from '@/lib/backendTransport';
import { isTauriClient } from '@/lib/desktopShell';
import { getErrorMessage } from '@/lib/modals';
import { useBackendTransport } from '@/lib/transport';

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
import { cn } from '@/lib/utils';

import { SettingsSection } from './SettingsUi';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';
import { DevicePairingPanel } from './DevicePairingPanel';
import { RemoteClientSettings } from './RemoteClientSettings';
import { SurfaceLoading } from '@/components/layout/SurfaceLoading';

type RemoteRoleTab = 'server' | 'client';

const DEFAULT_CONFIG: WebServiceConfig = {
  port: 17891,
  token: null,
  auto_start: false,
  allow_lan: false,
};

function sameConfig(a: WebServiceConfig, b: WebServiceConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function WebServiceSettings({
  transport: transportOverride,
}: {
  transport?: BackendTransport;
} = {}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const { t } = useTranslation(['settings', 'common']);
  const [draft, setDraft] = useState<WebServiceConfig>(DEFAULT_CONFIG);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [probe, setProbe] = useState<PortProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusBusy, setStatusBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const hostConsole = isTauriClient(transport.environment);
  const boundToRemote = transport.environment === 'remote-desktop';
  const [role, setRole] = useState<RemoteRoleTab>(() =>
    hostConsole && boundToRemote ? 'client' : 'server'
  );
  const serviceRunning = Boolean(status?.running);
  const { writeNow, writeSettled, flush, holdingRef } = useLiveSettingsCommit(
    async (next: WebServiceConfig) => {
      if (!validPort(next.port)) return;
      try {
        const saved = await webServiceApi.updateConfig(next);
        setDraft((current) => {
          if (!sameConfig(current, next)) return current;
          draftRef.current = saved;
          return saved;
        });
        setProbe(null);
        setStatus(await webServiceApi.getStatus());
      } catch (error) {
        const raw = getErrorMessage(error);
        toast.error(
          raw && raw !== 'An unknown error occurred'
            ? raw
            : t('webService.configSaveFailed')
        );
        try {
          const [actualConfig, actualStatus] = await Promise.all([
            webServiceApi.getConfig(),
            webServiceApi.getStatus(),
          ]);
          draftRef.current = actualConfig;
          setDraft(actualConfig);
          setStatus(actualStatus);
        } catch {
          // Ignore secondary refresh error
        }
      }
    }
  );
  const commitDraft = (next: WebServiceConfig, settle = false) => {
    draftRef.current = next;
    setDraft(next);
    if (!validPort(next.port)) return;
    if (settle) writeSettled(next);
    else writeNow(next);
  };

  const load = useCallback(
    async (showSpinner = true) => {
      if (!hostConsole || boundToRemote) {
        setLoading(false);
        return;
      }
      if (showSpinner) setLoading(true);
      try {
        const [savedConfig, currentStatus] = await Promise.all([
          webServiceApi.getConfig(),
          webServiceApi.getStatus(),
        ]);
        if (!holdingRef.current) {
          draftRef.current = savedConfig;
          setDraft(savedConfig);
        }
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
    },
    [boundToRemote, holdingRef, hostConsole, t]
  );

  useEffect(() => {
    if (boundToRemote) setRole('client');
  }, [boundToRemote]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const reloadFromJson = () => {
      if (!holdingRef.current) void load(false);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, reloadFromJson);
    return () =>
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reloadFromJson);
  }, [holdingRef, load]);

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

  const startServer = useCallback(async () => {
    await flush();

    setStatusBusy(true);
    try {
      const next = await webServiceApi.start();
      const saved = await webServiceApi.getConfig();
      if (!holdingRef.current) {
        draftRef.current = saved;
        setDraft(saved);
      }
      setStatus(next);
      setProbe(null);
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
  }, [flush, holdingRef, t]);

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
      const [nextStatus, result] = await Promise.all([
        webServiceApi.getStatus(),
        webServiceApi.probePort(draft.port),
      ]);
      setStatus(nextStatus);
      setProbe(result);
      const healthy = Boolean(nextStatus.running) || result.available;
      toast[healthy ? 'success' : 'error'](
        healthy
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

  if (loading) {
    return <SurfaceLoading />;
  }

  const portHealthy =
    serviceRunning &&
    (probe === null || probe.available || status?.port === draft.port);

  return (
    <div className="settings-content">
      <div className="chat-channel-heading">
        <div className="chat-channel-heading__copy">
          <h2>
            <Globe aria-hidden="true" />
            <span>{t('webService.title')}</span>
          </h2>
        </div>
        {hostConsole && !boundToRemote ? (
          <div className="chat-channel-heading__actions">
            <SegmentedControl
              value={role}
              onChange={(next) => setRole(next as RemoteRoleTab)}
              label={t('webService.roleTabsAria')}
              className="dsh-plugin-mode-segmented"
            >
              <SegmentedControlItem
                value="server"
                label={t('webService.roleServer')}
                icon={<Server aria-hidden="true" />}
              />
              <SegmentedControlItem
                value="client"
                label={t('webService.roleClient')}
                icon={<Laptop aria-hidden="true" />}
              />
            </SegmentedControl>
          </div>
        ) : null}
      </div>

      {role === 'client' && hostConsole ? <RemoteClientSettings /> : null}

      {!boundToRemote && (role === 'server' || !hostConsole) ? (
        <div className="settings-sections">
          {hostConsole ? (
            <SettingsSection
              icon={Globe}
              title={t('webService.hostSectionTitle')}
              description={t('webService.hostSectionDescription')}
            >
              <div className="settings-row">
                <div>
                  <Label
                    htmlFor={serviceRunning ? 'web-service-port' : undefined}
                  >
                    {t('webService.remoteServiceStatusLabel')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  {serviceRunning ? (
                    <div className="relative flex items-center">
                      <Input
                        id="web-service-port"
                        aria-label={t('webService.portLabel')}
                        type="number"
                        min={1}
                        max={65535}
                        value={draft.port || ''}
                        className="h-8 w-32 pr-8 font-mono text-sm"
                        onChange={(event) => {
                          const port = Number(event.target.value);
                          commitDraft({ ...draftRef.current, port }, true);
                        }}
                        onBlur={() => void flush()}
                      />
                      <button
                        type="button"
                        onClick={() => void probePort()}
                        disabled={probing || statusBusy}
                        title={t('webService.refreshStatus')}
                        aria-label={t('webService.refreshStatus')}
                        data-testid="web-service-status-lamp"
                        data-status={portHealthy ? 'healthy' : 'unhealthy'}
                        className={cn(
                          'absolute right-2 inline-flex !h-5 !min-h-0 !w-5 cursor-pointer items-center justify-center border-0 bg-transparent p-0 transition-opacity hover:bg-transparent hover:opacity-80 focus-visible:outline-none',
                          portHealthy
                            ? 'text-[hsl(var(--success))]'
                            : 'text-destructive'
                        )}
                      >
                        {probing ? (
                          <Loader2
                            className="vu-toast-status-icon vu-toast-status-icon-loading"
                            aria-hidden="true"
                          />
                        ) : portHealthy ? (
                          <CheckCircle2
                            className="vu-toast-status-icon"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleAlert
                            className="vu-toast-status-icon"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </div>
                  ) : null}
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

              {serviceRunning ? (
                <>
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
                        commitDraft({
                          ...draftRef.current,
                          auto_start: checked,
                        })
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
                        commitDraft({ ...draftRef.current, allow_lan: checked })
                      }
                    />
                  </div>
                </>
              ) : null}
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
            showTunnel={hostConsole}
            onReachabilityChange={() => void refreshStatus()}
          />
        </div>
      ) : null}
    </div>
  );
}
