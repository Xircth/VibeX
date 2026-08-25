import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronDown, Copy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  hostTunnelApi,
  type HostTunnelStatus,
  type SavedHostTunnel,
} from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';
import { cn } from '@/lib/utils';

type TunnelMode = 'existing' | 'create';

const EMPTY_STATUS: HostTunnelStatus = {
  enabled: false,
  saved: [],
  active_id: null,
  pending: null,
  relay_state: 'idle',
  last_error: null,
};

export function HostTunnelPanel({
  serviceRunning,
  onReachabilityChange,
}: {
  serviceRunning: boolean;
  onReachabilityChange: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [status, setStatus] = useState<HostTunnelStatus>(EMPTY_STATUS);
  const [mode, setMode] = useState<TunnelMode>('existing');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [listExpanded, setListExpanded] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const savedListId = useId();

  const applyStatus = useCallback((next: HostTunnelStatus) => {
    setStatus(next);
    if (next.pending) setMode('create');
  }, []);

  const refresh = useCallback(async () => {
    applyStatus(await hostTunnelApi.get());
  }, [applyStatus]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const next = await hostTunnelApi.get();
        applyStatus(next);
        if (!next.pending && next.active_id) {
          setPolling(false);
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
      toast.error(getErrorMessage(error) || t('webService.tunnelSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const checkExisting = async () => {
    if (!requireRunning()) return;
    const value = address.trim();
    if (!value && !status.active_id) {
      toast.error(t('webService.tunnelAddressRequired'));
      return;
    }
    setBusy(true);
    try {
      if (value) {
        const result = await hostTunnelApi.checkExisting(value);
        toast.success(
          result.http
            ? t('webService.tunnelSavedHttp')
            : t('webService.tunnelSaved')
        );
        await refresh();
      }
      onReachabilityChange();
    } catch (error) {
      toast.error(getErrorMessage(error) || t('webService.tunnelCheckFailed'));
    } finally {
      setBusy(false);
    }
  };

  const selectSaved = async (id: string) => {
    setBusy(true);
    try {
      applyStatus(await hostTunnelApi.selectSaved(id));
      onReachabilityChange();
    } catch (error) {
      toast.error(getErrorMessage(error) || t('webService.tunnelSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const startCreate = async () => {
    if (!requireRunning()) return;
    const value = address.trim();
    if (!value) {
      toast.error(t('webService.tunnelAddressRequired'));
      return;
    }
    setBusy(true);
    try {
      applyStatus(await hostTunnelApi.startCreate(value));
      setMode('create');
    } catch (error) {
      toast.error(getErrorMessage(error) || t('webService.tunnelSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmCreate = async () => {
    if (!requireRunning()) return;
    setBusy(true);
    try {
      applyStatus(await hostTunnelApi.confirmCreate());
      setPolling(true);
    } catch (error) {
      toast.error(getErrorMessage(error) || t('webService.tunnelCheckFailed'));
    } finally {
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

  const kindLabel = (kind: string) =>
    kind === 'relay'
      ? t('webService.tunnelModeCreate')
      : t('webService.tunnelModeExisting');

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
        <>
          <div className="settings-row">
            <div>
              <Label htmlFor="host-tunnel-mode">
                {t('webService.tunnelMode')}
              </Label>
            </div>
            <Select
              value={mode}
              onValueChange={(value: TunnelMode) => setMode(value)}
              disabled={busy}
            >
              <SelectTrigger id="host-tunnel-mode" className="!w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="existing">
                  {t('webService.tunnelModeExisting')}
                </SelectItem>
                <SelectItem value="create">
                  {t('webService.tunnelModeCreate')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === 'existing' ? (
            <div className="settings-row settings-row--stacked">
              <Label htmlFor="host-tunnel-address">
                {t('webService.tunnelAddress')}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="host-tunnel-address"
                  value={address}
                  placeholder="gate.example.com"
                  disabled={busy}
                  onChange={(event) => setAddress(event.target.value)}
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={busy}
                  onClick={() => void checkExisting()}
                >
                  {busy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {t('webService.tunnelCheck')}
                </Button>
              </div>
              <p className="settings-row__description">
                {t('webService.tunnelAddressHint')}
              </p>
            </div>
          ) : (
            <div className="settings-row settings-row--stacked">
              <Label htmlFor="host-tunnel-create-address">
                {t('webService.tunnelCreateAddress')}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="host-tunnel-create-address"
                  value={address}
                  placeholder="203.0.113.10"
                  disabled={busy}
                  onChange={(event) => setAddress(event.target.value)}
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={busy}
                  onClick={() => void startCreate()}
                >
                  {t('webService.tunnelGenerateCommand')}
                </Button>
              </div>
              <p className="settings-row__description">
                {t('webService.tunnelCreateHint')}
              </p>
              {status.pending ? (
                <>
                  <div className="flex gap-2">
                    <code className="settings-row__description min-w-0 flex-1 break-all font-mono text-xs">
                      {status.pending.command}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 shrink-0 p-0"
                      onClick={() => void copyCommand(status.pending!.command)}
                      aria-label={t('webService.copyOrigin')}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-8 text-xs"
                      disabled={busy}
                      onClick={() => void confirmCreate()}
                    >
                      {busy || polling ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {polling
                        ? t('webService.tunnelPolling')
                        : t('webService.tunnelConfirm')}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          )}

          <div className="settings-pairing-devices">
            <button
              type="button"
              className="settings-pairing-devices__toggle"
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
            {listExpanded ? (
              <div id={savedListId} className="settings-pairing-devices__list">
                {status.saved.length === 0 ? (
                  <p className="settings-pairing-devices__empty">
                    {t('webService.tunnelSavedEmpty')}
                  </p>
                ) : (
                  status.saved.map((item) => {
                    const active = item.id === status.active_id;
                    return (
                      <div
                        className="settings-pairing-devices__row"
                        key={item.id}
                      >
                        <button
                          type="button"
                          className="settings-pairing-devices__choose"
                          disabled={busy || active}
                          onClick={() => void selectSaved(item.id)}
                        >
                          <p className="truncate text-sm font-medium">
                            {item.origin}
                          </p>
                          <p className="settings-row__description">
                            <span className="settings-pairing-devices__preset">
                              {kindLabel(item.kind)}
                            </span>
                            {' · '}
                            {item.host}:{item.port}
                            {active
                              ? ` · ${
                                  item.kind === 'relay' &&
                                  status.relay_state !== 'connected'
                                    ? t('webService.tunnelPolling')
                                    : t('webService.tunnelInUse')
                                }`
                              : null}
                          </p>
                        </button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 shrink-0"
                          onClick={() => void removeSaved(item)}
                          disabled={removingId === item.id}
                        >
                          {removingId === item.id ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          {t('webService.tunnelRemove')}
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>

          {polling && status.last_error ? (
            <p className="settings-row__description">{status.last_error}</p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
