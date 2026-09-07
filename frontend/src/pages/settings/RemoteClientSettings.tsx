import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  ChevronDown,
  Laptop,
  Loader2,
  Radio,
  RefreshCw,
  Server,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import {
  hostClientApi,
  type DiscoveredHost,
  type HostClientProfile,
  type SavedHostUpdateView,
} from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';

import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { createPluginControlApi } from '@/lib/api/plugins';
import { tauriBackendTransport } from '@/lib/transport';
import {
  localProvisionerSurfaces,
  provisionedHostPayload,
  provisionerForKind,
  type LocalProvisionerSurface,
} from './localProvisionerSurfaces';
import {
  provisionKindLabel,
  savedHostAddress,
  savedHostOrigin,
  savedHostSource,
  type SavedHostSource,
} from './savedHostAddress';
import { SettingsSection } from './SettingsUi';

function isNeedsToken(error: unknown): boolean {
  return getErrorMessage(error).includes('needs_token');
}

function connectErrorMessage(
  error: unknown,
  failed: string,
  loginRejected: string
): string {
  const message = getErrorMessage(error);
  if (/permission denied/i.test(message)) return loginRejected;
  const cleaned = message
    .replace(/^(internal error:\s*)+/i, '')
    .replace(/^(worker_request_failed:\s*)+/i, '')
    .replace(/^(worker_failed:\s*)+/i, '')
    .trim();
  return cleaned || failed;
}

const HOST_SOURCE_COPY: Record<SavedHostSource, string> = {
  discovered: 'webService.hostSourceDiscovered',
  manual: 'webService.hostSourceManual',
  ssh: 'webService.hostSourceSsh',
  other: 'webService.hostSourceOther',
};

function SavedHostFacts({ profile }: { profile: HostClientProfile }) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('settings-host-facts', open && 'is-open')}>
      <button
        type="button"
        className="settings-host-facts__toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {t('webService.hostDetails')}
      </button>
      {open ? (
        <dl>
          <div>
            <dt>{t('webService.hostSourceLabel')}</dt>
            <dd>
              {t(HOST_SOURCE_COPY[savedHostSource(profile.provision_kind)])}
            </dd>
          </div>
          <div>
            <dt>{t('webService.hostAddressLabel')}</dt>
            <dd>
              <code title={savedHostAddress(profile)}>
                {savedHostAddress(profile)}
              </code>
            </dd>
          </div>
          {profile.host_id ? (
            <div>
              <dt>{t('webService.hostIdLabel')}</dt>
              <dd>
                <code title={profile.host_id}>{profile.host_id}</code>
              </dd>
            </div>
          ) : null}
          {profile.last_connected_at ? (
            <div>
              <dt>{t('webService.lastConnectedLabel')}</dt>
              <dd>{new Date(profile.last_connected_at).toLocaleString()}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function hostKey(host: { origin: string; host_id?: string | null }): string {
  return host.host_id?.trim() || host.origin;
}

function useLocalProvisioners() {
  const [panels, setPanels] = useState<LocalProvisionerSurface[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const api = useMemo(() => createPluginControlApi(tauriBackendTransport), []);
  const surfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(tauriBackendTransport),
    []
  );

  const reload = useCallback(async () => {
    const [catalog, contributions] = await Promise.all([
      api.catalog(),
      api.contributionCatalog(),
    ]);
    setPanels(localProvisionerSurfaces(catalog, contributions));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void reload().catch(() => {
      if (!cancelled) setPanels([]);
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const open = useCallback(
    (panel: LocalProvisionerSurface) => {
      if (!panel.plugin.enabled) {
        void api
          .setEnabled(panel.plugin.id, true)
          .then(() => reload())
          .then(() => setOpenId(panel.plugin.id))
          .catch(() => undefined);
        return;
      }
      setOpenId((current) =>
        current === panel.plugin.id ? null : panel.plugin.id
      );
    },
    [api, reload]
  );

  return { panels, openId, open, surfaceTransport, api };
}

export function RemoteClientSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const provisioners = useLocalProvisioners();
  const [profiles, setProfiles] = useState<HostClientProfile[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualOrigin, setManualOrigin] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [hostUpdates, setHostUpdates] = useState<SavedHostUpdateView[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const connected = profiles.find((profile) => profile.connected) ?? null;

  const loadStatus = useCallback(async () => {
    const status = await hostClientApi.status();
    setProfiles(status.profiles);
    return status;
  }, []);

  const loadHostUpdates = useCallback(async () => {
    try {
      setHostUpdates(await hostClientApi.hostUpdates());
    } catch {
      setHostUpdates([]);
    }
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setDiscovered(await hostClientApi.discover());
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.clientDiscoverFailed')
      );
    } finally {
      setScanning(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadStatus();
        if (!cancelled) await scan();
        if (!cancelled) await loadHostUpdates();
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : t('webService.clientStatusFailed')
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadHostUpdates, loadStatus, scan, t]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => {
      void loadStatus().catch((error) => {
        if (isNeedsToken(error)) {
          toast.error(t('webService.clientRevoked'));
        }
      });
    }, 8000);
    return () => window.clearInterval(timer);
  }, [connected, loadStatus, t]);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void listen('host-client-changed', () => {
      if (!cancelled) void loadStatus().catch(() => undefined);
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [loadStatus]);

  const savedMatch = useCallback(
    (host: DiscoveredHost) =>
      profiles.find(
        (profile) =>
          (host.host_id && profile.host_id === host.host_id) ||
          profile.origin === host.origin
      ),
    [profiles]
  );

  const connect = useCallback(
    async (request: {
      origin?: string;
      token?: string;
      profile_id?: string;
      key: string;
    }) => {
      setConnectingKey(request.key);
      try {
        const result = await hostClientApi.connect({
          origin: request.origin,
          token: request.token,
          profile_id: request.profile_id,
        });
        await loadStatus();
        setToken('');
        setManualCode('');
        setTokenFor(null);
        setExpandedId(result.profile.id);
        if (result.profile.connected) {
          toast.success(t('webService.clientConnected'));
        }
        if (result.stopped_host) {
          toast.success(t('webService.stoppedHostForClient'));
        }
      } catch (error) {
        if (isNeedsToken(error)) {
          setTokenFor(request.key);
          toast.error(t('webService.clientNeedsCode'));
          await loadStatus().catch(() => undefined);
        } else {
          toast.error(
            connectErrorMessage(
              error,
              t('webService.clientConnectFailed'),
              t('webService.sshLoginRejected')
            )
          );
        }
      } finally {
        setConnectingKey(null);
      }
    },
    [loadStatus, t]
  );

  const connectDiscovered = useCallback(
    async (host: DiscoveredHost) => {
      const key = hostKey(host);
      const saved = savedMatch(host);
      if (saved?.has_credential && tokenFor !== key) {
        await connect({
          origin: host.origin,
          profile_id: saved.id,
          key,
        });
        return;
      }
      if (!token.trim()) {
        setTokenFor(key);
        return;
      }
      await connect({ origin: host.origin, token: token.trim(), key });
    },
    [connect, savedMatch, token, tokenFor]
  );

  const connectSaved = useCallback(
    async (profile: HostClientProfile) => {
      const source = savedHostSource(profile.provision_kind);
      let origin = savedHostOrigin(profile);
      if (source === 'ssh' || source === 'other') {
        const provisioner = provisionerForKind(
          provisioners.panels,
          profile.provision_kind
        );
        if (!provisioner?.handler) {
          toast.error(
            t('webService.provisionerRequired', {
              label:
                provisionKindLabel(
                  profile.provision_kind,
                  provisioners.panels
                ) || profile.provision_kind,
            })
          );
          return;
        }
        setConnectingKey(profile.id);
        try {
          if (!provisioner.plugin.enabled) {
            await provisioners.api.setEnabled(provisioner.plugin.id, true);
          }
          const ensured = (await provisioners.api.invokeContribution(
            provisioner.plugin.id,
            provisioner.handler,
            { profile: provisionedHostPayload(profile) },
            provisioner.timeoutSeconds
          )) as { origin?: unknown };
          const ensuredOrigin =
            typeof ensured?.origin === 'string' ? ensured.origin.trim() : '';
          if (!ensuredOrigin) {
            throw new Error(t('webService.clientConnectFailed'));
          }
          origin = ensuredOrigin;
        } catch (error) {
          toast.error(
            connectErrorMessage(
              error,
              t('webService.clientConnectFailed'),
              t('webService.sshLoginRejected')
            )
          );
          setConnectingKey(null);
          return;
        }
      }
      if (profile.has_credential && tokenFor !== profile.id) {
        await connect({
          profile_id: profile.id,
          origin,
          key: profile.id,
        });
        return;
      }
      if (!token.trim()) {
        setTokenFor(profile.id);
        setExpandedId(profile.id);
        return;
      }
      await connect({
        profile_id: profile.id,
        origin,
        token: token.trim(),
        key: profile.id,
      });
    },
    [connect, provisioners.api, provisioners.panels, t, token, tokenFor]
  );

  const connectManual = useCallback(async () => {
    const origin = manualOrigin.trim();
    if (!origin) {
      toast.error(t('webService.clientOriginRequired'));
      return;
    }
    const saved = profiles.find((profile) => profile.origin === origin);
    if (saved?.has_credential && !manualCode.trim()) {
      await connect({
        origin,
        profile_id: saved.id,
        key: 'manual',
      });
      return;
    }
    if (!manualCode.trim() && !saved?.has_credential) {
      toast.error(t('webService.clientNeedsCode'));
      return;
    }
    await connect({
      origin,
      token: manualCode.trim() || undefined,
      profile_id: saved?.id,
      key: 'manual',
    });
    setManualOpen(false);
  }, [connect, manualCode, manualOrigin, profiles, t]);

  const disconnectHost = useCallback(async () => {
    try {
      await hostClientApi.disconnect();
      await loadStatus();
      toast.success(t('webService.clientDisconnected'));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('webService.clientConnectFailed')
      );
    }
  }, [loadStatus, t]);

  const confirmHostUpdate = useCallback(
    async (profile: HostClientProfile, update: SavedHostUpdateView) => {
      const confirmed = await ConfirmDialog.show({
        title: t('webService.hostUpdateTitle'),
        message: t('webService.hostUpdateMessage', {
          name: profile.name,
          address: savedHostAddress(profile),
          from: update.current_version ?? '—',
          to: update.latest_version ?? '—',
        }),
        confirmText: t('webService.hostUpdateConfirm'),
        cancelText: t('common:cancel'),
        variant: 'info',
      });
      if (confirmed !== 'confirmed') return;
      setUpdatingId(profile.id);
      try {
        const result = await hostClientApi.applyHostUpdate(profile.id);
        toast.success(
          t('webService.hostUpdateDone', { version: result.toVersion })
        );
        await loadStatus();
        await loadHostUpdates();
      } catch (error) {
        const message = getErrorMessage(error);
        toast.error(
          message.includes('host_update_unreachable')
            ? t('webService.hostUpdateFailed')
            : message
        );
        await loadHostUpdates();
      } finally {
        setUpdatingId(null);
      }
    },
    [loadHostUpdates, loadStatus, t]
  );

  const deleteHost = useCallback(
    async (profile: HostClientProfile) => {
      const confirmed = await ConfirmDialog.show({
        title: t('webService.deleteHostTitle'),
        message: t('webService.deleteHostMessage', { name: profile.name }),
        confirmText: t('webService.deleteHost'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (confirmed !== 'confirmed') return;
      try {
        await hostClientApi.delete(profile.id);
        await loadStatus();
        if (expandedId === profile.id) setExpandedId(null);
        toast.success(t('webService.clientHostDeleted'));
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('webService.clientDeleteFailed')
        );
      }
    },
    [expandedId, loadStatus, t]
  );

  const discoveredVisible = useMemo(
    () =>
      discovered.filter(
        (host) =>
          !connected ||
          hostKey(host) !== (connected.host_id || connected.origin)
      ),
    [connected, discovered]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const openProvisioner = provisioners.panels.find(
    (panel) => panel.plugin.id === provisioners.openId
  );

  return (
    <div className="settings-sections">
      <SettingsSection
        icon={Radio}
        title={t('webService.discoverTitle')}
        action={
          <div className="flex items-center gap-2">
            {provisioners.panels.map((panel) => {
              const Icon = contributionIconComponent(panel.icon, Laptop);
              return (
                <Button
                  key={panel.plugin.id}
                  variant="outline"
                  size="sm"
                  className="h-8"
                  aria-pressed={provisioners.openId === panel.plugin.id}
                  onClick={() => provisioners.open(panel)}
                >
                  <Icon className="mr-1 h-3.5 w-3.5" />
                  {panel.label}
                </Button>
              );
            })}
            <Popover open={manualOpen} onOpenChange={setManualOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  <Laptop className="mr-1 h-3.5 w-3.5" />
                  {t('webService.manualTitle')}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="settings-manual-connect w-80"
              >
                <div>
                  <Label htmlFor="host-client-origin">
                    {t('webService.manualOriginLabel')}
                  </Label>
                  <Input
                    id="host-client-origin"
                    value={manualOrigin}
                    onChange={(event) => setManualOrigin(event.target.value)}
                    placeholder={t('webService.manualOriginPlaceholder')}
                    className="mt-1 font-mono"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor="host-client-code">
                    {t('webService.clientCodeLabel')}
                  </Label>
                  <Input
                    id="host-client-code"
                    value={manualCode}
                    onChange={(event) => setManualCode(event.target.value)}
                    placeholder={t('webService.clientCodePlaceholder')}
                    className="mt-1 font-mono"
                    autoComplete="off"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-8 self-end"
                  onClick={() => void connectManual()}
                  disabled={connectingKey === 'manual'}
                >
                  {connectingKey === 'manual' ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {t('webService.clientConnect')}
                </Button>
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void scan()}
              disabled={scanning}
            >
              {scanning ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {t('webService.discoverRefresh')}
            </Button>
          </div>
        }
      >
        {discoveredVisible.length === 0 ? (
          <p className="settings-row__description px-4 py-3">
            {t('webService.discoverEmpty')}
          </p>
        ) : (
          discoveredVisible.map((host) => {
            const key = hostKey(host);
            const asking = tokenFor === key;
            const busy = connectingKey === key;
            return (
              <div className="settings-host-row" key={key}>
                <div className="settings-host-row__summary">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {host.name || host.origin}
                    </p>
                    <p className="settings-row__description font-mono">
                      {host.origin}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => void connectDiscovered(host)}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('webService.clientConnect')}
                  </Button>
                </div>
                {asking ? (
                  <div className="settings-host-row__detail">
                    <Label htmlFor={`lan-token-${key}`}>
                      {t('webService.clientCodeLabel')}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={`lan-token-${key}`}
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder={t('webService.clientCodePlaceholder')}
                        className="font-mono"
                        autoComplete="off"
                      />
                      <Button
                        size="sm"
                        className="h-8 shrink-0"
                        onClick={() => void connectDiscovered(host)}
                        disabled={busy}
                      >
                        {t('webService.clientConnect')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </SettingsSection>

      {openProvisioner?.plugin.enabled ? (
        <SettingsSection icon={Laptop} title={openProvisioner.label}>
          {openProvisioner.surfaces.map((surface) => (
            <AppSurfaceHost
              key={`${surface.surfaceId}:${surface.generation}`}
              descriptor={surface}
              enabled
              transport={provisioners.surfaceTransport}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection icon={Server} title={t('webService.savedTitle')}>
        <div className="settings-saved-hosts">
          {profiles.length === 0 ? (
            <p className="settings-pairing-devices__empty">
              {t('webService.savedEmpty')}
            </p>
          ) : (
            profiles.map((profile) => {
              const expanded = expandedId === profile.id;
              const asking = tokenFor === profile.id;
              const busy = connectingKey === profile.id;
              const update = hostUpdates.find(
                (item) =>
                  item.profile_id === profile.id && item.update_available
              );
              return (
                <div
                  className={cn(
                    'settings-host-row',
                    profile.connected && 'is-connected',
                    expanded && 'is-expanded'
                  )}
                  key={profile.id}
                >
                  <div className="settings-host-row__header">
                    <button
                      type="button"
                      className="settings-host-row__summary"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedId((current) =>
                          current === profile.id ? null : profile.id
                        )
                      }
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 truncate text-sm font-medium">
                          <span className="truncate">{profile.name}</span>
                          {profile.connected ? (
                            <span className="settings-status-success rounded-full px-2 py-0.5 text-xs font-medium">
                              {t('webService.connectedBadge')}
                            </span>
                          ) : null}
                          {provisionKindLabel(
                            profile.provision_kind,
                            provisioners.panels
                          ) ? (
                            <span className="rounded-full border border-[color:var(--border-subtle)] px-2 py-0.5 text-xs font-medium text-[color:var(--text-muted)]">
                              {provisionKindLabel(
                                profile.provision_kind,
                                provisioners.panels
                              )}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                          expanded && 'rotate-180'
                        )}
                        aria-hidden="true"
                      />
                    </button>
                    {update ? (
                      <button
                        type="button"
                        className="settings-host-row__update settings-status-pill-warning text-xs font-medium"
                        disabled={updatingId === profile.id}
                        onClick={() => {
                          void confirmHostUpdate(profile, update);
                        }}
                      >
                        {updatingId === profile.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          t('webService.hostUpdateAvailable')
                        )}
                      </button>
                    ) : null}
                  </div>
                  {expanded ? (
                    <div className="settings-host-row__detail">
                      <SavedHostFacts profile={profile} />
                      {asking ? (
                        <Input
                          value={token}
                          onChange={(event) => setToken(event.target.value)}
                          placeholder={t('webService.clientCodePlaceholder')}
                          className="font-mono"
                          autoComplete="off"
                        />
                      ) : null}
                      <div className="flex flex-wrap justify-end gap-2">
                        {profile.connected ? (
                          <Button
                            size="sm"
                            className="h-8"
                            onClick={() => void disconnectHost()}
                          >
                            {t('webService.clientDisconnect')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="h-8"
                            onClick={() => void connectSaved(profile)}
                            disabled={busy}
                          >
                            {busy ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {connected
                              ? t('webService.switchHost')
                              : t('webService.clientConnect')}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          onClick={() => void deleteHost(profile)}
                        >
                          {t('webService.deleteHost')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
