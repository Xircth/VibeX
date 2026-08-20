import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';

import { SettingsSection } from './SettingsUi';

function isNeedsToken(error: unknown): boolean {
  return getErrorMessage(error).includes('needs_token');
}

function hostKey(host: { origin: string; host_id?: string | null }): string {
  return host.host_id?.trim() || host.origin;
}

export function RemoteClientSettings() {
  const { t } = useTranslation(['settings', 'common']);
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

  const connected = profiles.find((profile) => profile.connected) ?? null;

  const loadStatus = useCallback(async () => {
    const status = await hostClientApi.status();
    setProfiles(status.profiles);
    return status;
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
  }, [loadStatus, scan, t]);

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
        setManualToken('');
        setTokenFor(null);
        setExpandedId(result.profile.id);
        toast.success(t('webService.clientConnected'));
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
            error instanceof Error
              ? error.message
              : t('webService.clientConnectFailed')
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
      if (profile.has_credential && tokenFor !== profile.id) {
        await connect({
          profile_id: profile.id,
          origin: profile.origin,
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
        origin: profile.origin,
        token: token.trim(),
        key: profile.id,
      });
    },
    [connect, token, tokenFor]
  );

  const connectManual = useCallback(async () => {
    const origin = manualOrigin.trim();
    if (!origin) {
      toast.error(t('webService.clientOriginRequired'));
      return;
    }
    const saved = profiles.find((profile) => profile.origin === origin);
    if (saved?.has_credential && !manualToken.trim()) {
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

  return (
    <div className="settings-sections">
      <SettingsSection
        icon={Radio}
        title={t('webService.discoverTitle')}
        action={
          <div className="flex items-center gap-2">
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
              return (
                <div
                  className={cn(
                    'settings-host-row',
                    profile.connected && 'is-connected'
                  )}
                  key={profile.id}
                >
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
                      </p>
                      <p className="settings-row__description font-mono">
                        {profile.origin}
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
                  {expanded ? (
                    <div className="settings-host-row__detail">
                      {profile.host_id ? (
                        <p className="settings-row__description font-mono">
                          {t('webService.hostIdLabel')}: {profile.host_id}
                        </p>
                      ) : null}
                      {profile.last_connected_at ? (
                        <p className="settings-row__description">
                          {t('webService.lastConnectedLabel')}:{' '}
                          {new Date(profile.last_connected_at).toLocaleString()}
                        </p>
                      ) : null}
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
