import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Laptop,
  Link2,
  Loader2,
  RefreshCw,
  Server,
  Settings,
  Terminal,
} from 'lucide-react';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import {
  hostClientApi,
  openSettingsSurface,
  type DiscoveredHost,
  type HostClientProfile,
} from '@/lib/api';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { createPluginControlApi } from '@/lib/api/plugins';
import { backendListen } from '@/lib/backendTransport';
import { DesktopCapabilityError, isTauriClient } from '@/lib/desktopShell';
import { getErrorMessage } from '@/lib/modals';
import { tauriBackendTransport, useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import {
  localProvisionerSurfaces,
  prefillProvisionerSettings,
  provisionedHostPayload,
  provisionerForKind,
  type LocalProvisionerSurface,
} from '@/pages/settings/localProvisionerSurfaces';
import {
  savedHostAddress,
  savedHostOrigin,
  savedHostSource,
} from '@/pages/settings/savedHostAddress';

const REMOTE_CLIENT_SETTINGS_PATH = '/settings/web-service?role=client';
const REMOTE_SSH_SETTINGS_PATH = '/settings/web-service?role=client&action=ssh';

type ConnectDialogSeed = {
  origin: string;
  profileId?: string;
};

function useSafeNavigate(): (path: string) => void {
  const navContext = useContext(UNSAFE_NavigationContext);
  return useCallback(
    (path: string) => {
      if (navContext?.navigator) {
        navContext.navigator.push(path);
      } else if (typeof window !== 'undefined') {
        window.location.assign(path);
      }
    },
    [navContext]
  );
}

function isNeedsToken(error: unknown): boolean {
  return getErrorMessage(error).includes('needs_token');
}

function formatConnectError(
  error: unknown,
  fallback: string,
  loginRejected: string
): string {
  const message = getErrorMessage(error);
  if (/permission denied/i.test(message)) return loginRejected;
  const cleaned = message
    .replace(/^(internal error:\s*)+/i, '')
    .replace(/^(worker_request_failed:\s*)+/i, '')
    .replace(/^(worker_failed:\s*)+/i, '')
    .trim();
  return cleaned || fallback;
}

function ConnectHostDialog({
  seed,
  profiles,
  onClose,
  onConnected,
}: {
  seed: ConnectDialogSeed;
  profiles: HostClientProfile[];
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const { t } = useTranslation(['panels', 'settings', 'common']);
  const [origin, setOrigin] = useState(seed.origin);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const originInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (seed.origin) {
        codeInputRef.current?.focus();
      } else {
        originInputRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [seed.origin]);

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const trimmedOrigin = origin.trim();
    const trimmedCode = code.trim();
    if (!trimmedOrigin) {
      toast.error(
        t('settings:webService.clientOriginRequired', '请输入 Host 地址')
      );
      return;
    }

    const matchedProfile =
      (seed.profileId
        ? profiles.find((item) => item.id === seed.profileId)
        : undefined) ??
      profiles.find(
        (item) =>
          item.origin === trimmedOrigin ||
          savedHostOrigin(item) === trimmedOrigin
      );

    if (
      !trimmedCode &&
      (!matchedProfile?.has_credential || matchedProfile.needs_token)
    ) {
      toast.error(t('settings:webService.clientNeedsCode', '请输入连接码'));
      return;
    }

    setSubmitting(true);
    try {
      const result = await hostClientApi.connect({
        origin: trimmedOrigin,
        token: trimmedCode || undefined,
        profile_id: matchedProfile?.id,
      });
      await onConnected();
      if (result.profile.connected) {
        toast.success(t('settings:webService.clientConnected', '已连接'));
      }
      if (result.stopped_host) {
        toast.success(
          t('settings:webService.stoppedHostForClient', '已停止本机远程连接服务')
        );
      }
      onClose();
    } catch (error) {
      if (error instanceof DesktopCapabilityError) {
        toast.error(
          t(
            'toolbar.desktopOnlyHostConnect',
            '请在桌面端应用中连接或切换远程 Host'
          )
        );
        return;
      }
      if (isNeedsToken(error)) {
        toast.error(t('settings:webService.clientNeedsCode', '请输入连接码'));
        codeInputRef.current?.focus();
        return;
      }
      toast.error(
        formatConnectError(
          error,
          t('settings:webService.clientConnectFailed', '连接失败'),
          t(
            'settings:webService.sshLoginRejected',
            'SSH 拒绝登录。核对用户名、密码或密钥。'
          )
        )
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent
        data-testid="connect-host-dialog"
        className="sm:max-w-[420px]"
      >
        <DialogHeader>
          <DialogTitle>
            {t('toolbar.connectHostDialogTitle', '连接远程 Host')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'toolbar.connectHostDialogDescription',
              '输入目标 Host 的服务地址与连接码以建立加密连接。'
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label>{t('settings:webService.manualOriginLabel', 'Host 地址')}</Label>
            <TextInput
              ref={originInputRef}
              label={t('settings:webService.manualOriginLabel', 'Host 地址')}
              isLabelHidden
              value={origin}
              onChange={setOrigin}
              placeholder={t(
                'settings:webService.manualOriginPlaceholder',
                '192.168.1.10:17891'
              )}
              width="100%"
              className="[&_input]:font-mono [&_input]:text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('settings:webService.clientCodeLabel', '连接码')}</Label>
            <TextInput
              ref={codeInputRef}
              label={t('settings:webService.clientCodeLabel', '连接码')}
              isLabelHidden
              value={code}
              onChange={setCode}
              placeholder={t(
                'settings:webService.clientCodePlaceholder',
                '8 位连接码'
              )}
              width="100%"
              className="[&_input]:font-mono [&_input]:text-sm"
            />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              {t('common:cancel', '取消')}
            </Button>
            <Button
              type="submit"
              size="sm"
              data-dialog-primary="true"
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t('settings:webService.clientConnect', '连接')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewSshHostDialog({
  onClose,
  onFallbackToSettings,
}: {
  onClose: () => void;
  onFallbackToSettings: () => void;
}) {
  const { t } = useTranslation(['panels', 'common']);
  const contextTransport = useBackendTransport();
  const activeTransport = isTauriClient()
    ? tauriBackendTransport
    : contextTransport;
  const pluginApi = useMemo(
    () => createPluginControlApi(activeTransport),
    [activeTransport]
  );
  const surfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(activeTransport),
    [activeTransport]
  );
  const [sshPanel, setSshPanel] = useState<LocalProvisionerSurface | null>(
    null
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catalog, contributions] = await Promise.all([
          pluginApi.catalog(),
          pluginApi.contributionCatalog(),
        ]);
        let panels = localProvisionerSurfaces(catalog, contributions);
        let target = panels.find((item) => item.kind === 'ssh') ?? null;
        if (target && !target.plugin.enabled) {
          await pluginApi.setEnabled(target.plugin.id, true);
          const [nextCatalog, nextContributions] = await Promise.all([
            pluginApi.catalog(),
            pluginApi.contributionCatalog(),
          ]);
          panels = localProvisionerSurfaces(nextCatalog, nextContributions);
          target = panels.find((item) => item.kind === 'ssh') ?? null;
        }
        if (cancelled) return;
        if (!target) {
          onClose();
          onFallbackToSettings();
          return;
        }
        setSshPanel(target);
      } catch {
        if (!cancelled) {
          onClose();
          onFallbackToSettings();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onClose, onFallbackToSettings, pluginApi]);

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="new-ssh-host-dialog"
        className="max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {t('toolbar.newSshHostDialogTitle', '新建 SSH Host')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'toolbar.newSshHostDialogDescription',
              '通过 SSH 自动部署并连接到远程主机上的服务。'
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-[240px] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sshPanel ? (
          <div className="min-w-0">
            {sshPanel.surfaces.map((surface) => (
              <AppSurfaceHost
                key={`${surface.surfaceId}:${surface.generation}`}
                descriptor={surface}
                enabled
                transport={surfaceTransport}
              />
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
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
  const [connectDialogSeed, setConnectDialogSeed] =
    useState<ConnectDialogSeed | null>(null);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);

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

  const resolveProvisionerForProfile = useCallback(
    async (profile: HostClientProfile) => {
      const pluginApi = createPluginControlApi(tauriBackendTransport);
      const [catalog, contributions] = await Promise.all([
        pluginApi.catalog(),
        pluginApi.contributionCatalog(),
      ]);
      const panels = localProvisionerSurfaces(catalog, contributions);
      const provisioner = provisionerForKind(panels, profile.provision_kind);
      return { pluginApi, provisioner };
    },
    []
  );

  const handleSelectProfile = async (profile: HostClientProfile) => {
    if (profile.connected) {
      setOpen(false);
      return;
    }

    const source = savedHostSource(profile.provision_kind);
    const durableOrigin = savedHostOrigin(profile) || profile.origin;

    if (source !== 'ssh' && source !== 'other') {
      if (profile.needs_token || !profile.has_credential) {
        setOpen(false);
        setConnectDialogSeed({
          origin: durableOrigin,
          profileId: profile.id,
        });
        return;
      }

      setSwitchingKey(profile.id);
      try {
        await hostClientApi.connect({
          profile_id: profile.id,
          origin: durableOrigin || undefined,
        });
        await loadStatus();
        setOpen(false);
      } catch (error) {
        setOpen(false);
        if (isNeedsToken(error)) {
          setConnectDialogSeed({
            origin: durableOrigin,
            profileId: profile.id,
          });
        } else {
          toast.error(
            formatConnectError(
              error,
              t('settings:webService.clientConnectFailed', '连接失败'),
              t(
                'settings:webService.sshLoginRejected',
                'SSH 拒绝登录。核对用户名、密码或密钥。'
              )
            )
          );
          openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
        }
      } finally {
        setSwitchingKey(null);
      }
      return;
    }

    setSwitchingKey(profile.id);
    let resolvedPluginApi: ReturnType<typeof createPluginControlApi> | null =
      null;
    let resolvedProvisioner: LocalProvisionerSurface | null = null;
    try {
      const { pluginApi, provisioner } =
        await resolveProvisionerForProfile(profile);
      resolvedPluginApi = pluginApi;
      resolvedProvisioner = provisioner;

      let origin = durableOrigin;
      if (provisioner?.handler) {
        if (!provisioner.plugin.enabled) {
          await pluginApi.setEnabled(provisioner.plugin.id, true);
        }
        const ensured = (await pluginApi.invokeContribution(
          provisioner.plugin.id,
          provisioner.handler,
          { profile: provisionedHostPayload(profile) },
          provisioner.timeoutSeconds
        )) as { origin?: unknown };
        const ensuredOrigin =
          typeof ensured?.origin === 'string' ? ensured.origin.trim() : '';
        if (ensuredOrigin) {
          origin = ensuredOrigin;
        }
      }

      await hostClientApi.connect({
        profile_id: profile.id,
        origin: origin || undefined,
      });
      await loadStatus();
      setOpen(false);
    } catch (error) {
      setOpen(false);
      if (source === 'ssh') {
        if (resolvedPluginApi && resolvedProvisioner) {
          await prefillProvisionerSettings(
            resolvedPluginApi,
            resolvedProvisioner.plugin.id,
            profile
          );
        }
        if (!isNeedsToken(error)) {
          toast.error(
            formatConnectError(
              error,
              t('settings:webService.clientConnectFailed', '连接失败'),
              t(
                'settings:webService.sshLoginRejected',
                'SSH 拒绝登录。核对用户名、密码或密钥。'
              )
            )
          );
        }
        setSshDialogOpen(true);
      } else if (isNeedsToken(error)) {
        setConnectDialogSeed({
          origin: durableOrigin,
          profileId: profile.id,
        });
      } else {
        openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
      }
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
    } catch (error) {
      setOpen(false);
      if (isNeedsToken(error)) {
        setConnectDialogSeed({ origin: host.origin });
      } else {
        openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
      }
    } finally {
      setSwitchingKey(null);
    }
  };

  const handleOpenConnectHost = () => {
    setOpen(false);
    setConnectDialogSeed({ origin: '' });
  };

  const handleOpenNewSshHost = () => {
    setOpen(false);
    setSshDialogOpen(true);
  };

  const handleManageRemoteConnections = () => {
    setOpen(false);
    openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH);
  };

  const unsavedDiscovered = discovered.filter(
    (host) =>
      !profiles.some(
        (profile) =>
          (host.host_id && profile.host_id === host.host_id) ||
          savedHostOrigin(profile) === host.origin ||
          profile.origin === host.origin
      )
  );

  const currentLabel = connectedProfile
    ? connectedProfile.name || savedHostAddress(connectedProfile)
    : t('toolbar.localHost', 'Local Host');

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="toolbar-host-selector"
            aria-label={t('toolbar.selectHost', '切换运行主机')}
            aria-expanded={open}
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
                  '-bottom-0.5 -right-0.5 absolute h-1.5 w-1.5 rounded-full',
                  connectedProfile ? 'bg-primary' : 'bg-success'
                )}
              />
            </span>
            <span className="max-w-32 truncate">{currentLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          data-testid="host-selector-popover"
          className="w-[372px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/80 p-0 shadow-xl"
        >
          <div
            data-testid="host-selector-actions"
            className="flex items-center gap-1 border-b border-border/60 p-1.5"
          >
            <button
              type="button"
              data-testid="host-selector-connect-host"
              onClick={handleOpenConnectHost}
              className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t('toolbar.connectHost', '连接 Host')}</span>
            </button>

            <button
              type="button"
              data-testid="host-selector-new-ssh-host"
              onClick={handleOpenNewSshHost}
              className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t('toolbar.newSshHost', '新建 SSH Host')}</span>
            </button>

            <button
              type="button"
              data-testid="host-selector-manage-remote"
              onClick={handleManageRemoteConnections}
              className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {t('toolbar.manageRemoteConnections', '管理远程连接')}
              </span>
            </button>
          </div>

          <div className="max-h-[min(360px,calc(100vh-8rem))] space-y-0.5 overflow-y-auto p-1.5">
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-medium text-muted-foreground">
              <span>{t('toolbar.hostSectionTitle', '运行主机 (Host)')}</span>
              {isTauriClient() ? (
                <button
                  type="button"
                  data-testid="host-selector-refresh"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void scanHosts();
                  }}
                  className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                  title={t('common:refresh', '刷新')}
                >
                  <RefreshCw
                    className={cn('h-3 w-3', scanning && 'animate-spin')}
                  />
                </button>
              ) : null}
            </div>

            <button
              type="button"
              data-testid="host-selector-item-local"
              onClick={() => void handleSelectLocal()}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                !connectedProfile
                  ? 'bg-foreground/[0.05] text-foreground'
                  : 'text-foreground/90 hover:bg-foreground/[0.06]'
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <Laptop className="h-3.5 w-3.5 shrink-0 text-success" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">
                      {t('toolbar.localHost', 'Local Host')}
                    </span>
                    <span
                      data-testid="host-selector-local-badge"
                      className="inline-flex shrink-0 items-center rounded bg-foreground/[0.08] px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
                    >
                      {t('toolbar.localBadge', '本地')}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    127.0.0.1
                  </div>
                </div>
              </div>
              {switchingKey === 'local' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : !connectedProfile ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              ) : null}
            </button>

            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                data-testid={`host-selector-item-${profile.id}`}
                onClick={() => void handleSelectProfile(profile)}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  profile.connected
                    ? 'bg-foreground/[0.05] text-foreground'
                    : 'text-foreground/90 hover:bg-foreground/[0.06]'
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {savedHostSource(profile.provision_kind) === 'ssh' ? (
                    <Terminal className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <Server className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {profile.name || savedHostAddress(profile)}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {savedHostAddress(profile)}
                    </div>
                  </div>
                </div>
                {switchingKey === profile.id ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : profile.connected ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                ) : null}
              </button>
            ))}

            {unsavedDiscovered.length > 0 ? (
              <>
                <div className="my-1 h-px bg-border/60" />
                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  {t('toolbar.discoveredHosts', '局域网发现的主机')}
                </div>
                {unsavedDiscovered.map((host) => {
                  const key = host.host_id || host.origin;
                  return (
                    <button
                      key={key}
                      type="button"
                      data-testid={`host-selector-discovered-${key}`}
                      onClick={() => void handleSelectDiscovered(host)}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition-colors hover:bg-foreground/[0.06]"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {host.name || host.origin}
                          </div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {host.origin}
                          </div>
                        </div>
                      </div>
                      {switchingKey === key ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                  );
                })}
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {connectDialogSeed ? (
        <ConnectHostDialog
          seed={connectDialogSeed}
          profiles={profiles}
          onClose={() => setConnectDialogSeed(null)}
          onConnected={loadStatus}
        />
      ) : null}

      {sshDialogOpen ? (
        <NewSshHostDialog
          onClose={() => setSshDialogOpen(false)}
          onFallbackToSettings={() =>
            openSettingsSurface(navigate, REMOTE_SSH_SETTINGS_PATH)
          }
        />
      ) : null}
    </>
  );
}
