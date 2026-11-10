import { useCallback, useEffect, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Laptop,
  Loader2,
  RefreshCw,
  Server,
  Settings,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  hostClientApi,
  openSettingsSurface,
  type DiscoveredHost,
  type HostClientProfile,
} from '@/lib/api';
import { backendListen } from '@/lib/backendTransport';
import { isTauriClient } from '@/lib/desktopShell';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

function useSafeNavigate(): (path: string) => void {
  const inRouter = useInRouterContext();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const routerNavigate = inRouter ? useNavigate() : null;
  return useCallback(
    (path: string) => {
      if (routerNavigate) {
        routerNavigate(path);
      } else if (typeof window !== 'undefined') {
        window.location.assign(path);
      }
    },
    [routerNavigate]
  );
}

export function HostSelector() {
  const { t } = useTranslation(['panels', 'settings', 'common']);
  const navigate = useSafeNavigate();
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<HostClientProfile[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);

  const connectedProfile =
    profiles.find((profile) => profile.connected) ?? null;

  const loadStatus = useCallback(async () => {
    if (!isTauriClient()) return;
    try {
      const status = await hostClientApi.status();
      setProfiles(status.profiles ?? []);
    } catch {
      // Ignore in web / non-desktop contexts.
    }
  }, []);

  const scanHosts = useCallback(async () => {
    if (!isTauriClient()) return;
    setScanning(true);
    try {
      const list = await hostClientApi.discover();
      setDiscovered(list ?? []);
    } catch {
      // Ignore discovery errors in selector.
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    let stop: (() => void) | undefined;
    let cancelled = false;
    void backendListen('host-client-changed', () => {
      if (!cancelled) void loadStatus();
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

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    void scanHosts();
  }, [loadStatus, open, scanHosts]);

  const handleSelectLocal = async () => {
    if (!connectedProfile) {
      setOpen(false);
      return;
    }
    setSwitchingKey('local');
    try {
      await hostClientApi.disconnect();
      await loadStatus();
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('settings:webService.clientStatusFailed', '切换主机失败')
      );
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleSelectProfile = async (profile: HostClientProfile) => {
    if (profile.connected) {
      setOpen(false);
      return;
    }
    setSwitchingKey(profile.id);
    try {
      await hostClientApi.connect({ profile_id: profile.id });
      await loadStatus();
      setOpen(false);
    } catch {
      setOpen(false);
      openSettingsSurface(navigate, '/settings/remote-client');
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleSelectDiscovered = async (host: DiscoveredHost) => {
    const key = host.host_id || host.origin;
    setSwitchingKey(key);
    try {
      await hostClientApi.connect({ origin: host.origin });
      await loadStatus();
      setOpen(false);
    } catch {
      setOpen(false);
      openSettingsSurface(navigate, '/settings/remote-client');
    } finally {
      setSwitchingKey(null);
    }
  };

  const unsavedDiscovered = discovered.filter(
    (host) =>
      !profiles.some(
        (profile) =>
          (host.host_id && profile.host_id === host.host_id) ||
          profile.origin === host.origin
      )
  );

  const currentLabel = connectedProfile
    ? connectedProfile.name || connectedProfile.origin
    : t('toolbar.localHost', 'Local Host');

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="toolbar-host-selector"
          aria-label={t('toolbar.selectHost', 'Switch Host')}
          className={cn(
            'workspace-toolbar-button flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
            'hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
        >
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            {connectedProfile ? (
              <Server className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Laptop className="h-3.5 w-3.5 opacity-80" />
            )}
            <span
              className={cn(
                ' -bottom-0.5 -right-0.5 absolute h-1.5 w-1.5 rounded-full',
                connectedProfile ? 'bg-sky-500' : 'bg-emerald-500'
              )}
            />
          </span>
          <span className="max-w-32 truncate">{currentLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="flex items-center justify-between text-[11px] font-semibold opacity-70">
          <span>{t('toolbar.hostSectionTitle', '运行主机 (Host)')}</span>
          {isTauriClient() ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void scanHosts();
              }}
              className="rounded p-0.5 hover:bg-foreground/10"
              title={t('common:refresh', '刷新')}
            >
              <RefreshCw
                className={cn('h-3 w-3', scanning && 'animate-spin')}
              />
            </button>
          ) : null}
        </DropdownMenuLabel>

        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void handleSelectLocal();
          }}
          className="flex items-center justify-between gap-2 text-xs"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Laptop className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <div className="min-w-0">
              <div className="truncate font-medium">
                {t('toolbar.localHost', 'Local Host')}
              </div>
              <div className="truncate text-[10px] opacity-60">
                127.0.0.1 · {t('toolbar.localDaemon', '本机守护进程')}
              </div>
            </div>
          </div>
          {switchingKey === 'local' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : !connectedProfile ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
          ) : null}
        </DropdownMenuItem>

        {profiles.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            onSelect={(event) => {
              event.preventDefault();
              void handleSelectProfile(profile);
            }}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Server className="h-3.5 w-3.5 shrink-0 text-sky-500" />
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {profile.name || profile.origin}
                </div>
                <div className="truncate text-[10px] opacity-60">
                  {profile.origin}
                </div>
              </div>
            </div>
            {switchingKey === profile.id ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : profile.connected ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}

        {unsavedDiscovered.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] font-medium opacity-60">
              {t('toolbar.discoveredHosts', '局域网发现的主机')}
            </DropdownMenuLabel>
            {unsavedDiscovered.map((host) => {
              const key = host.host_id || host.origin;
              return (
                <DropdownMenuItem
                  key={key}
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleSelectDiscovered(host);
                  }}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Server className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {host.name || host.origin}
                      </div>
                      <div className="truncate text-[10px] opacity-60">
                        {host.origin}
                      </div>
                    </div>
                  </div>
                  {switchingKey === key ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setOpen(false);
            openSettingsSurface(navigate, '/settings/remote-client');
          }}
          className="flex items-center gap-2 text-xs"
        >
          <Settings className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span>{t('toolbar.manageHosts', '管理远程主机连接...')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
