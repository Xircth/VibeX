import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  Loader2,
  Plus,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import {
  hostTunnelApi,
  type HostTunnelStatus,
  type SavedHostTunnel,
} from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';
import '@/features/collaboration/collaboration.css';

const EMPTY_STATUS: HostTunnelStatus = {
  enabled: false,
  saved: [],
  active_id: null,
  pending: null,
  relay_state: 'idle',
  last_error: null,
};

type TunnelConnectivityResult = {
  connected: boolean;
  latencyMs: number;
  message: string;
  origin?: string;
  http?: boolean;
};

function tunnelErrorMessage(
  error: unknown,
  t: (key: string) => string
): string {
  const raw = getErrorMessage(error);
  if (raw.includes('Generate a setup command first')) {
    return t('webService.tunnelNeedCommand');
  }
  if (raw.includes('waiting for this Host')) {
    return t('webService.tunnelRelayWait');
  }
  if (raw.includes('did not answer')) {
    return t('webService.tunnelHealthFailed');
  }
  if (
    raw.includes('Could not reach a VibeX Host') ||
    raw.includes('For a new VPS tunnel')
  ) {
    return t('webService.tunnelHostUnreachable');
  }
  return raw || t('webService.tunnelCheckFailed');
}

function TunnelConnectivityStatus({
  result,
  t,
}: {
  result: TunnelConnectivityResult;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <div
      role="status"
      data-testid="tunnel-connectivity-status"
      data-connected={result.connected ? 'true' : 'false'}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs',
        result.connected
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-destructive/30 bg-destructive/10 text-destructive'
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
        {result.connected ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">{result.message}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] opacity-90">
        {t('webService.tunnelLatencyMs', { ms: result.latencyMs })}
      </span>
    </div>
  );
}

function formatTunnelCreatedAt(
  isoOrTimestamp: string | null | undefined
): string {
  if (!isoOrTimestamp) return '—';
  const date = new Date(isoOrTimestamp);
  if (Number.isNaN(date.getTime())) return isoOrTimestamp;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

function TunnelUsageBadge({
  active,
  polling,
  t,
}: {
  active: boolean;
  polling: boolean;
  t: (key: string) => string;
}) {
  return (
    <span
      data-testid="tunnel-usage-badge"
      data-state={active ? 'in-use' : 'unused'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        active
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-border/70 bg-muted/60 text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          active
            ? 'bg-emerald-500 dark:bg-emerald-400'
            : 'bg-muted-foreground/50'
        )}
        aria-hidden="true"
      />
      <span>
        {active
          ? polling
            ? t('webService.tunnelPolling')
            : t('webService.tunnelInUse')
          : t('webService.tunnelNotInUse')}
      </span>
    </span>
  );
}

export function HostTunnelPanel({
  serviceRunning,
  onReachabilityChange,
}: {
  serviceRunning: boolean;
  onReachabilityChange: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const portalContainer = usePortalContainer();
  const [status, setStatus] = useState<HostTunnelStatus>(EMPTY_STATUS);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [listExpanded, setListExpanded] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [setupCommand, setSetupCommand] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalLeft, setModalLeft] = useState('12.5rem');
  const [testResult, setTestResult] = useState<TunnelConnectivityResult | null>(
    null
  );
  const [preTestSavedIds, setPreTestSavedIds] = useState<Set<string>>(
    () => new Set()
  );
  const [createdTunnelIds, setCreatedTunnelIds] = useState<string[]>([]);
  const savedListId = useId();

  const applyStatus = useCallback((next: HostTunnelStatus) => {
    setStatus(next);
    if (next.pending?.command) {
      setSetupCommand(next.pending.command);
    }
    if (!next.enabled) setSetupCommand(null);
  }, []);

  const refresh = useCallback(async () => {
    const next = await hostTunnelApi.get();
    applyStatus(next);
    return next;
  }, [applyStatus]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!modalOpen) return;
    const settingsShell = document.querySelector('.settings-page');
    settingsShell?.classList.add('collaboration-settings-window-blurred');

    const syncOverlayLeft = () => {
      const settingsContent = document.querySelector<HTMLElement>(
        '[data-settings-content]'
      );
      const settingsSidebar =
        document.querySelector<HTMLElement>('.settings-sidebar');
      const contentLeft = settingsContent?.getBoundingClientRect().left ?? 0;
      const sidebarRight = settingsSidebar?.getBoundingClientRect().right ?? 0;
      const measuredLeft = contentLeft > 0 ? contentLeft : sidebarRight;
      if (measuredLeft > 0) {
        setModalLeft(`${Math.round(measuredLeft)}px`);
        return;
      }
      setModalLeft(
        settingsSidebar?.classList.contains('settings-sidebar--flush')
          ? '11rem'
          : '12.5rem'
      );
    };

    syncOverlayLeft();
    window.addEventListener('resize', syncOverlayLeft);
    return () => {
      window.removeEventListener('resize', syncOverlayLeft);
      settingsShell?.classList.remove('collaboration-settings-window-blurred');
    };
  }, [modalOpen]);

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const next = await hostTunnelApi.get();
        applyStatus(next);
        if (!next.pending && next.active_id) {
          setPolling(false);
          setSetupCommand(null);
          onReachabilityChange();
          toast.success(t('webService.tunnelConnected'));
        }
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [applyStatus, onReachabilityChange, polling, t]);

  const requireRunning = () => {
    if (serviceRunning) return true;
    toast.error(t('webService.enableServiceFirst'));
    return false;
  };

  const toggleEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      applyStatus(await hostTunnelApi.setEnabled(enabled));
      onReachabilityChange();
    } catch (error) {
      toast.error(
        tunnelErrorMessage(error, t) || t('webService.tunnelSaveFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const openCreateModal = () => {
    setAddress('');
    setSetupCommand(status.pending?.command ?? null);
    setTestResult(null);
    setPreTestSavedIds(new Set(status.saved.map((item) => item.id)));
    setCreatedTunnelIds([]);
    setModalOpen(true);
  };

  const closeCreateModal = async () => {
    setModalOpen(false);
    setPolling(false);
    setTestResult(null);
    setSetupCommand(null);
    try {
      if (status.pending) {
        await hostTunnelApi.cancelCreate();
      }
      for (const id of createdTunnelIds) {
        if (!preTestSavedIds.has(id)) {
          await hostTunnelApi.removeSaved(id);
        }
      }
      await refresh();
    } catch {
      // Ignore cleanup errors on cancel
    }
  };

  const startCreate = async () => {
    if (!requireRunning()) return;
    const value = address.trim();
    if (!value) {
      toast.error(t('webService.tunnelAddressRequired'));
      return;
    }
    setGenerating(true);
    setBusy(true);
    setTestResult(null);
    try {
      const next = await hostTunnelApi.startCreate(value);
      applyStatus(next);
      if (next.pending?.command) setSetupCommand(next.pending.command);
    } catch (error) {
      toast.error(
        tunnelErrorMessage(error, t) || t('webService.tunnelSaveFailed')
      );
    } finally {
      setGenerating(false);
      setBusy(false);
    }
  };

  const testConnectivity = async () => {
    if (!requireRunning()) return;
    const value = address.trim();
    if (!value && !status.pending && !setupCommand && !status.active_id) {
      toast.error(t('webService.tunnelAddressRequired'));
      return;
    }
    setTesting(true);
    setBusy(true);
    const startedAt = performance.now();
    try {
      const beforeIds = new Set(status.saved.map((item) => item.id));
      let connectedHttp = false;
      if (value) {
        try {
          const result = await hostTunnelApi.checkExisting(value);
          connectedHttp = result.http;
        } catch (checkError) {
          if (status.pending || setupCommand) {
            const confirmedStatus = await hostTunnelApi.confirmCreate();
            applyStatus(confirmedStatus);
            if (confirmedStatus.pending && !confirmedStatus.active_id) {
              throw new Error(t('webService.tunnelRelayWait'));
            }
          } else {
            throw checkError;
          }
        }
      } else {
        const confirmedStatus = await hostTunnelApi.confirmCreate();
        applyStatus(confirmedStatus);
        if (confirmedStatus.pending && !confirmedStatus.active_id) {
          throw new Error(t('webService.tunnelRelayWait'));
        }
      }

      const latest = await refresh();
      const addedIds = latest.saved
        .filter((item) => !beforeIds.has(item.id))
        .map((item) => item.id);
      if (addedIds.length > 0) {
        setCreatedTunnelIds((prev) => [...new Set([...prev, ...addedIds])]);
      }

      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      setTestResult({
        connected: true,
        latencyMs,
        message: t('webService.tunnelTestConnected'),
        http: connectedHttp,
      });
    } catch (error) {
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      const msg = tunnelErrorMessage(error, t);
      setTestResult({
        connected: false,
        latencyMs,
        message: `${t('webService.tunnelTestFailed')} · ${msg}`,
      });
      toast.error(msg);
    } finally {
      setTesting(false);
      setBusy(false);
    }
  };

  const handleSaveModal = async () => {
    if (!testResult?.connected) return;
    setModalOpen(false);
    setCreatedTunnelIds([]);
    setTestResult(null);
    setSetupCommand(null);
    await refresh().catch(() => undefined);
    onReachabilityChange();
    toast.success(t('webService.tunnelSaved'));
  };

  const toggleSavedTunnel = async (item: SavedHostTunnel, active: boolean) => {
    setBusy(true);
    setTogglingId(item.id);
    try {
      applyStatus(await hostTunnelApi.selectSaved(active ? null : item.id));
      onReachabilityChange();
    } catch (error) {
      toast.error(getErrorMessage(error) || t('webService.tunnelSaveFailed'));
    } finally {
      setTogglingId(null);
      setBusy(false);
    }
  };

  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    toast.success(
      t('webService.copied', { label: t('webService.tunnelCommand') })
    );
  };

  const removeSaved = async (item: SavedHostTunnel) => {
    const confirmed = await ConfirmDialog.show({
      title: t('webService.tunnelRemoveTitle'),
      message: t('webService.tunnelRemoveMessage', { name: item.origin }),
      confirmText: t('webService.tunnelRemove'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (confirmed !== 'confirmed') return;
    setRemovingId(item.id);
    try {
      applyStatus(await hostTunnelApi.removeSaved(item.id));
      onReachabilityChange();
    } catch (error) {
      toast.error(getErrorMessage(error) || t('webService.tunnelSaveFailed'));
    } finally {
      setRemovingId(null);
    }
  };

  const activeCommand = status.pending?.command ?? setupCommand ?? '';

  return (
    <>
      <div className="settings-row">
        <div>
          <Label htmlFor="host-tunnel-enabled">
            {t('webService.tunnelLabel')}
          </Label>
          <p className="settings-row__description">
            {t('webService.tunnelDescription')}
          </p>
        </div>
        <Switch
          id="host-tunnel-enabled"
          className="settings-switch"
          checked={status.enabled}
          disabled={busy}
          onCheckedChange={(checked: boolean) => void toggleEnabled(checked)}
        />
      </div>

      {status.enabled ? (
        <div className="settings-pairing-block flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="settings-pairing-devices__toggle flex-1"
              aria-expanded={listExpanded}
              aria-controls={savedListId}
              onClick={() => setListExpanded((current) => !current)}
            >
              <span>{t('webService.tunnelSavedList')}</span>
              <span className="settings-pairing-devices__count">
                {status.saved.length}
              </span>
              <ChevronDown
                className={cn(
                  'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                  listExpanded && 'rotate-180'
                )}
                aria-hidden="true"
              />
            </button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={openCreateModal}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('webService.tunnelModeCreate')}
            </Button>
          </div>

          {listExpanded ? (
            <div
              className="settings-pairing-devices settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
              data-testid="saved-tunnels-list-container"
            >
              <div
                id={savedListId}
                className="settings-pairing-devices__list settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
                data-testid="saved-tunnels-scroll-box"
              >
                {status.saved.length === 0 ? (
                  <p className="settings-pairing-devices__empty">
                    {t('webService.tunnelSavedEmpty')}
                  </p>
                ) : (
                  status.saved.map((item) => {
                    const active = item.id === status.active_id;
                    const isRelayPolling =
                      active &&
                      item.kind === 'relay' &&
                      status.relay_state !== 'connected';
                    return (
                      <div
                        className="settings-pairing-devices__row flex min-h-10 min-w-0 items-center justify-between gap-3 px-3 py-2"
                        key={item.id}
                      >
                        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_8.5rem] items-center gap-3">
                          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                            <span
                              className="truncate text-xs font-medium text-foreground"
                              title={item.origin}
                            >
                              {item.origin}
                            </span>
                            <TunnelUsageBadge
                              active={active}
                              polling={isRelayPolling}
                              t={t}
                            />
                          </div>
                          <div className="flex min-w-0 items-center">
                            <span
                              className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                              title={`${item.host}:${item.port}`}
                            >
                              {item.host}:{item.port}
                            </span>
                          </div>
                          <span className="truncate text-xs tabular-nums text-muted-foreground">
                            {formatTunnelCreatedAt(item.created_at)}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 shrink-0 px-2.5 text-xs"
                            disabled={busy || togglingId === item.id}
                            onClick={() => void toggleSavedTunnel(item, active)}
                          >
                            {togglingId === item.id ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {active
                              ? t('webService.tunnelDisable')
                              : t('webService.tunnelEnable')}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="h-7 shrink-0 px-2.5 text-xs"
                            onClick={() => void removeSaved(item)}
                            disabled={removingId === item.id}
                          >
                            {removingId === item.id ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            {t('webService.tunnelRemove')}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}

          {polling && status.last_error ? (
            <p className="settings-row__description">{status.last_error}</p>
          ) : null}
        </div>
      ) : null}

      {modalOpen
        ? createPortal(
            <div
              data-testid="host-tunnel-modal-overlay"
              className="collaboration-thread-overlay collaboration-settings-modal-overlay fixed inset-y-0 right-0 z-[9999] flex items-center justify-center p-6"
              style={{
                left: modalLeft,
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
              }}
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  void closeCreateModal();
                }
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={t('webService.tunnelModeCreate')}
                className="dialog-surface relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[480px] flex-col overflow-y-auto rounded-lg border border-border/70 p-4 shadow-xl"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">
                    {t('webService.tunnelModeCreate')}
                  </h3>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand h-7 w-7"
                    aria-label={t('common:close', '关闭')}
                    onClick={() => void closeCreateModal()}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>

                <div className="flex flex-col gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="host-tunnel-modal-address">
                      {t('webService.tunnelAddress')}
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="host-tunnel-modal-address"
                        value={address}
                        placeholder="203.0.113.10"
                        disabled={busy}
                        onChange={(event) => {
                          setAddress(event.target.value);
                          setTestResult(null);
                        }}
                        className="flex-1 text-sm"
                        autoFocus
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        className="shrink-0 text-xs"
                        disabled={busy}
                        onClick={() => void startCreate()}
                      >
                        {generating ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {t('webService.tunnelGenerateCommand')}
                      </Button>
                      <Button
                        type="button"
                        size="default"
                        className="shrink-0 text-xs"
                        disabled={busy}
                        onClick={() => void testConnectivity()}
                      >
                        {testing ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        {t('webService.tunnelTestConnectivity')}
                      </Button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t('webService.tunnelAddressHint')}
                    </p>
                  </div>

                  {activeCommand ? (
                    <div className="flex min-w-0 items-center gap-2">
                      <Input
                        readOnly
                        aria-label={t('webService.tunnelCommand')}
                        value={activeCommand}
                        onFocus={(event) => event.currentTarget.select()}
                        className="settings-command-line flex-1 font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="shrink-0"
                        onClick={() => void copyCommand(activeCommand)}
                        aria-label={t('webService.copyOrigin')}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}

                  {testResult ? (
                    <TunnelConnectivityStatus result={testResult} t={t} />
                  ) : null}

                  <div className="mt-1 flex items-center justify-end gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void closeCreateModal()}
                    >
                      {t('common:cancel', '取消')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!testResult?.connected || busy}
                      onClick={() => void handleSaveModal()}
                    >
                      {t('common:save', '保存')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>,
            portalContainer ?? document.body
          )
        : null}
    </>
  );
}
