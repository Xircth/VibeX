import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  QrCode,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import {
  CONNECT_REQUESTS_CHANGED_EVENT,
  notifyConnectRequestsChanged,
} from '@/components/layout/MobileDeviceConnectBanner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { openInSystemBrowser } from '@/hooks/useOpenLink';
import {
  webServiceApi,
  type HostPairedDevice,
  type PendingDeviceConnectRequest,
} from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';
import type {
  BackendTransport,
  DevicePairingChallenge,
} from '@/lib/backendTransport';
import { cn } from '@/lib/utils';
import { HostTunnelPanel } from './HostTunnelPanel';
import { SettingsSection } from './SettingsUi';
import {
  encodePairingInvitation,
  isLoopbackOrigin,
  DEFAULT_PAIRING_TTL_SECONDS,
  PAIRING_TTL_SECONDS,
  pairingDisplayOrigins,
  pairingLiveStatus,
  pairingVisibleOrigins,
  type PairingDisplayOrigin,
  type PairingListenAddress,
  type PairingReachability,
  type PairingTtlSeconds,
} from './pairingInvitation';

const PAIRING_QR_SIZE = 144;

type PairingPreset = 'companion' | 'workstation';

const EMPTY_HOST_URLS: string[] = [];
const EMPTY_REACHABILITY: PairingReachability[] = [];
const EMPTY_LISTEN_ADDRESSES: PairingListenAddress[] = [];

function resolveClientKind(
  device: HostPairedDevice
): 'mobile' | 'desktop' | 'web' {
  const explicit = device.client_kind?.toLowerCase();
  if (explicit === 'mobile' || explicit === 'desktop' || explicit === 'web') {
    return explicit;
  }
  const name = device.device_name || '';
  if (/\b(web|browser|chrome|safari|edge|firefox)\b/i.test(name)) {
    return 'web';
  }
  if (
    /\b(iphone|ipad|android|pixel|mobile|ios)\b/i.test(name) ||
    device.preset === 'companion'
  ) {
    return 'mobile';
  }
  return 'desktop';
}

function formatConnectedAt(isoOrTimestamp: string | null | undefined): string {
  if (!isoOrTimestamp) return '';
  const date = new Date(isoOrTimestamp);
  if (Number.isNaN(date.getTime())) return isoOrTimestamp;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export function DevicePairingPanel({
  transport,
  hostUrls = EMPTY_HOST_URLS,
  hostId,
  reachability = EMPTY_REACHABILITY,
  listenAddresses = EMPTY_LISTEN_ADDRESSES,
  autoIssue = false,
  serviceRunning = true,
  showTunnel = false,
  onReachabilityChange,
  onEnsureListening,
}: {
  transport: BackendTransport;
  hostUrls?: string[];
  hostId?: string | null;
  reachability?: PairingReachability[];
  listenAddresses?: PairingListenAddress[];
  autoIssue?: boolean;
  serviceRunning?: boolean;
  showTunnel?: boolean;
  onReachabilityChange?: () => void;
  onEnsureListening?: () => Promise<string[]>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const preset: PairingPreset = 'workstation';
  const [challenge, setChallenge] = useState<DevicePairingChallenge | null>(
    null
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoIssued, setAutoIssued] = useState(false);
  const [startedUrls, setStartedUrls] = useState<string[] | null>(null);
  const [devices, setDevices] = useState<HostPairedDevice[]>([]);
  const [pendingRequests, setPendingRequests] = useState<
    PendingDeviceConnectRequest[]
  >([]);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(
    null
  );
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [ttlSeconds, setTtlSeconds] = useState<PairingTtlSeconds>(
    DEFAULT_PAIRING_TTL_SECONDS
  );
  const [issuedAt, setIssuedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [devicesExpanded, setDevicesExpanded] = useState(true);
  const devicesListId = useId();
  const resolvedUrls = startedUrls ?? hostUrls;
  const resolvedReachability =
    challenge?.reachability ??
    (reachability.length > 0
      ? reachability
      : resolvedUrls
          .filter((origin) => !isLoopbackOrigin(origin))
          .map((origin) => ({ origin, kind: 'lan' })));
  const invitation = useMemo(() => {
    if (!challenge) return null;
    return (
      challenge.invitation ??
      encodePairingInvitation({
        hostId: challenge.host_id ?? hostId,
        preset: challenge.preset ?? preset,
        pairingId: challenge.pairing_id,
        pairingToken: challenge.pairing_token,
        expiresAt: challenge.expires_at,
        reachability: resolvedReachability,
      })
    );
  }, [challenge, hostId, preset, resolvedReachability]);
  const hasReachableOrigin =
    resolvedReachability.length > 0 || resolvedUrls.length > 0;

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await webServiceApi.listDevices());
    } catch {
      setDevices([]);
    }
    try {
      const requests = await webServiceApi.listConnectRequests();
      setPendingRequests(Array.isArray(requests) ? requests : []);
    } catch {
      setPendingRequests([]);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    const timer = window.setInterval(() => {
      void loadDevices();
    }, 3000);
    const handleChanged = () => {
      void loadDevices();
    };
    window.addEventListener(CONNECT_REQUESTS_CHANGED_EVENT, handleChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(CONNECT_REQUESTS_CHANGED_EVENT, handleChanged);
    };
  }, [loadDevices]);

  const respondConnectRequest = useCallback(
    async (request: PendingDeviceConnectRequest, approve: boolean) => {
      setRespondingRequestId(request.request_id);
      try {
        await webServiceApi.respondConnectRequest(request.request_id, approve);
        setPendingRequests((current) =>
          current.filter((item) => item.request_id !== request.request_id)
        );
        notifyConnectRequestsChanged();
        void loadDevices();
        if (approve) {
          toast.success(`已允许移动设备「${request.device_name}」连接`);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        toast.error(
          message && message !== 'An unknown error occurred'
            ? message
            : t('webService.pairingFailed')
        );
      } finally {
        setRespondingRequestId(null);
      }
    },
    [loadDevices, t]
  );

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  useEffect(() => {
    if (!invitation) {
      setQrDataUrl(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(invitation, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: PAIRING_QR_SIZE,
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl);
    });
    return () => {
      active = false;
    };
  }, [invitation]);

  const createPairing = useCallback(
    async (
      ttl: PairingTtlSeconds = ttlSeconds,
      issuePreset: PairingPreset = preset
    ) => {
      if (!serviceRunning) {
        toast.error(t('webService.enableServiceFirst'));
        return;
      }
      setBusy(true);
      try {
        if (onEnsureListening) {
          setStartedUrls(await onEnsureListening());
        }
        const created = transport.createDevicePairing
          ? await transport.createDevicePairing({
              preset: issuePreset,
              ttl_seconds: ttl,
            })
          : await webServiceApi.createPairing(issuePreset, ttl);
        setChallenge(created);
        setIssuedAt(Date.now());
        void loadDevices();
      } catch (error) {
        const message = getErrorMessage(error);
        toast.error(
          message && message !== 'An unknown error occurred'
            ? message
            : t('webService.pairingFailed')
        );
      } finally {
        setBusy(false);
      }
    },
    [
      loadDevices,
      onEnsureListening,
      preset,
      serviceRunning,
      t,
      transport,
      ttlSeconds,
    ]
  );

  useEffect(() => {
    if (!autoIssue || autoIssued || challenge || busy || !hasReachableOrigin) {
      return;
    }
    setAutoIssued(true);
    void createPairing();
  }, [
    autoIssue,
    autoIssued,
    busy,
    challenge,
    createPairing,
    hasReachableOrigin,
  ]);

  const connectionCode =
    challenge?.connection_code ??
    (challenge?.pairing_token && challenge.pairing_token.length === 8
      ? challenge.pairing_token
      : null);

  const revokeDevice = useCallback(
    async (device: HostPairedDevice) => {
      const confirmed = await ConfirmDialog.show({
        title: t('webService.revokeDeviceTitle'),
        message: t('webService.revokeDeviceMessage', {
          name: device.device_name,
        }),
        confirmText: t('webService.revokeDevice'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (confirmed !== 'confirmed') return;
      setRevokingId(device.device_id);
      try {
        await webServiceApi.revokeDevice(device.device_id);
        setDevices((current) =>
          current.filter((item) => item.device_id !== device.device_id)
        );
        toast.success(t('webService.deviceRevoked'));
      } catch (error) {
        const message = getErrorMessage(error);
        toast.error(
          message && message !== 'An unknown error occurred'
            ? message
            : t('webService.deviceRevokeFailed')
        );
      } finally {
        setRevokingId(null);
      }
    },
    [t]
  );

  const displayOrigins = useMemo(
    () =>
      pairingDisplayOrigins(
        resolvedReachability,
        resolvedUrls,
        listenAddresses
      ),
    [listenAddresses, resolvedReachability, resolvedUrls]
  );
  const visibleOrigins = pairingVisibleOrigins(displayOrigins, true);

  const addressKindLabel = (kind: PairingDisplayOrigin['kind']) => {
    if (kind === 'loopback') return t('webService.thisComputerAddressLabel');
    if (kind === 'lan') return t('webService.lanAddressLabel');
    return t('webService.publishedAddressLabel');
  };

  const copyConnectionCode = useCallback(async () => {
    if (!connectionCode) return;
    await navigator.clipboard.writeText(connectionCode);
    toast.success(t('webService.pairingCopied'));
  }, [connectionCode, t]);

  const copyOrigin = useCallback(
    async (origin: string) => {
      await navigator.clipboard.writeText(origin);
      toast.success(
        t('webService.copied', { label: t('webService.copyOrigin') })
      );
    },
    [t]
  );

  const liveStatus = challenge
    ? pairingLiveStatus({
        expiresAt: challenge.expires_at,
        now,
        issuedAt:
          issuedAt ?? Date.parse(challenge.expires_at) - ttlSeconds * 1000,
        devices,
      })
    : null;

  const addressesNode =
    displayOrigins.length > 0 ? (
      <div className="settings-pairing-block flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="settings-pairing-addresses__header">
          <span className="settings-pairing-addresses__label">
            {t('webService.pairingAddressesLabel')}
          </span>
          <span className="settings-pairing-devices__count">
            {visibleOrigins.length}
          </span>
        </div>
        <div className="settings-pairing-addresses settings-bounded-list-container min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background/50">
          <div
            className="settings-pairing-devices__list settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
            data-testid="pairing-addresses-scroll-box"
          >
            {visibleOrigins.map((item) => {
              const isCloudServiceUrl = item.origin.includes('/t/');
              const ifaceLabel =
                item.interface ??
                (item.kind === 'loopback'
                  ? 'loopback'
                  : item.kind === 'published'
                    ? isCloudServiceUrl
                      ? 'Beta'
                      : 'cloud'
                    : null);
              return (
                <div
                  className="settings-pairing-addresses__row flex min-h-10 min-w-0 items-center justify-between gap-3 px-3 py-2"
                  key={item.origin}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <span className="w-14 shrink-0 text-xs font-semibold text-foreground">
                      {addressKindLabel(item.kind)}
                    </span>
                    <span className="flex w-20 shrink-0 items-center">
                      {ifaceLabel ? (
                        <span
                          className={cn(
                            'settings-pairing-addresses__iface inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-xs font-medium',
                            item.kind === 'published'
                              ? 'border border-primary/25 bg-primary/10 text-primary'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {ifaceLabel}
                        </span>
                      ) : null}
                    </span>
                    {isCloudServiceUrl ? (
                      <span className="min-w-0 flex-1 truncate text-left text-xs font-medium text-muted-foreground">
                        {t('webService.tunnelOfficialNode', {
                          defaultValue: '官方云服务',
                        })}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="settings-pairing-addresses__origin min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                        title={item.origin}
                        onClick={() => void copyOrigin(item.origin)}
                        aria-label={`${t('webService.copyAddress')} ${item.origin}`}
                      >
                        {item.origin}
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!isCloudServiceUrl ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="settings-pairing-addresses__open !h-7 !min-h-0 !w-7 shrink-0 border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
                        onClick={() => void openInSystemBrowser(item.origin)}
                        aria-label={`${t('webService.openOrigin')} ${item.origin}`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    ) : null;

  return (
    <SettingsSection
      icon={QrCode}
      title={t('webService.clientSectionTitle')}
      description={t('webService.clientSectionDescription')}
      className={!serviceRunning ? 'settings-remote-gated' : undefined}
      action={
        <Button size="sm" onClick={() => void createPairing()} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <QrCode className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('webService.createPairing')}
        </Button>
      }
    >
      {serviceRunning && !hasReachableOrigin ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {t('webService.pairingNeedsReachability')}
        </p>
      ) : null}

      {pendingRequests.length > 0 ? (
        <div
          className="settings-pairing-block flex flex-col gap-1.5"
          data-testid="pending-connect-requests-block"
        >
          <div className="settings-pairing-addresses__header">
            <span className="settings-pairing-addresses__label">
              待确认连接请求
            </span>
            <span className="settings-pairing-devices__count">
              {pendingRequests.length}
            </span>
          </div>
          <div className="settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50">
            <div className="settings-bounded-list divide-y divide-border/60">
              {pendingRequests.map((req) => (
                <div
                  key={req.request_id}
                  className="flex min-h-11 items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <Smartphone className="h-4 w-4 shrink-0 text-foreground" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {req.device_name}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums text-foreground">
                      核对码 {req.sas_code}
                    </span>
                    {req.ip_address ? (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {req.ip_address}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      disabled={respondingRequestId === req.request_id}
                      onClick={() => void respondConnectRequest(req, true)}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      连接
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={respondingRequestId === req.request_id}
                      onClick={() => void respondConnectRequest(req, false)}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      忽略
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {challenge ? (
        <div
          className="settings-pairing-split"
          data-testid="pairing-active-split"
        >
          {addressesNode}
          <div className="settings-pairing-block flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="settings-pairing-addresses__header">
              <span className="settings-pairing-addresses__label">
                {t('webService.pairingCredentialLabel')}
              </span>
            </div>
            <div className="settings-pairing-body flex-1">
              <div className="settings-pairing-invite">
                <div className="settings-pairing-qr">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      width={PAIRING_QR_SIZE}
                      height={PAIRING_QR_SIZE}
                      alt={t('webService.pairingQrAlt')}
                    />
                  ) : (
                    <div
                      className="settings-pairing-qr__placeholder"
                      style={{
                        width: PAIRING_QR_SIZE,
                        height: PAIRING_QR_SIZE,
                      }}
                      aria-label={t('webService.pairingQrLoading')}
                    >
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  )}
                </div>
                {connectionCode ? (
                  <div className="settings-pairing-fields">
                    <div className="settings-pairing-code-row">
                      <p className="text-sm font-medium">
                        {t('webService.pairingCodeLabel')}
                      </p>
                      <div className="settings-pairing-code">
                        <code>{connectionCode}</code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="settings-pairing-code__copy"
                          onClick={() => void copyConnectionCode()}
                          aria-label={t('webService.copyPairingCode')}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="settings-pairing-meta">
                      <div className="settings-pairing-field">
                        <Label
                          htmlFor="pairing-ttl"
                          className="text-sm font-medium"
                        >
                          {t('webService.pairingTtlLabel')}
                        </Label>
                        <Select
                          value={String(ttlSeconds)}
                          onValueChange={(value) => {
                            const next = Number(value) as PairingTtlSeconds;
                            setTtlSeconds(next);
                            if (PAIRING_TTL_SECONDS.includes(next)) {
                              void createPairing(next);
                            }
                          }}
                        >
                          <SelectTrigger
                            id="pairing-ttl"
                            className="h-8 w-32 text-sm"
                            aria-label={t('webService.pairingTtlLabel')}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="end">
                            <SelectItem value="300">
                              {t('webService.pairingTtl5m')}
                            </SelectItem>
                            <SelectItem value="900">
                              {t('webService.pairingTtl15m')}
                            </SelectItem>
                            <SelectItem value="1800">
                              {t('webService.pairingTtl30m')}
                            </SelectItem>
                            <SelectItem value="3600">
                              {t('webService.pairingTtl60m')}
                            </SelectItem>
                            <SelectItem value="21600">
                              {t('webService.pairingTtl6h')}
                            </SelectItem>
                            <SelectItem value="86400">
                              {t('webService.pairingTtl1d')}
                            </SelectItem>
                            <SelectItem value="604800">
                              {t('webService.pairingTtl7d')}
                            </SelectItem>
                            <SelectItem value="2592000">
                              {t('webService.pairingTtl30d')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <p
                        className={cn(
                          'settings-pairing-status',
                          liveStatus === 'connected' &&
                            'settings-status-success',
                          liveStatus === 'failed' && 'text-destructive',
                          liveStatus === 'waiting' && 'text-muted-foreground'
                        )}
                        role="status"
                      >
                        <span
                          className={cn(
                            'settings-status-lamp',
                            liveStatus === 'connected' &&
                              'settings-status-dot-success',
                            liveStatus === 'failed' &&
                              'settings-status-dot-neutral',
                            liveStatus === 'waiting' &&
                              'settings-status-dot-neutral'
                          )}
                          aria-hidden="true"
                        />
                        {liveStatus === 'connected'
                          ? t('webService.pairingStatusConnected')
                          : liveStatus === 'failed'
                            ? t('webService.pairingStatusFailed')
                            : t('webService.pairingStatusWaiting')}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('webService.pairingOneTime', {
                  expiresAt: new Date(challenge.expires_at).toLocaleString(),
                })}
              </p>
            </div>
          </div>
        </div>
      ) : (
        addressesNode
      )}

      {showTunnel && onReachabilityChange ? (
        <HostTunnelPanel
          serviceRunning={serviceRunning}
          onReachabilityChange={onReachabilityChange}
        />
      ) : null}

      <div className="settings-pairing-block flex flex-col gap-1.5">
        <button
          type="button"
          className="settings-pairing-devices__toggle"
          aria-expanded={devicesExpanded}
          aria-controls={devicesListId}
          onClick={() => setDevicesExpanded((current) => !current)}
        >
          <span>{t('webService.pairedDevicesTitle')}</span>
          <span className="settings-pairing-devices__count">
            {devices.length}
          </span>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
              devicesExpanded && 'rotate-180'
            )}
            aria-hidden="true"
          />
        </button>
        {devicesExpanded ? (
          <div
            className="settings-pairing-devices settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
            data-testid="paired-devices-list-container"
          >
            <div
              id={devicesListId}
              className="settings-pairing-devices__list settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
              data-testid="paired-devices-scroll-box"
            >
              {devices.length === 0 ? (
                <p className="settings-pairing-devices__empty">
                  {t('webService.pairedDevicesEmpty')}
                </p>
              ) : (
                devices.map((device) => {
                  const kind = resolveClientKind(device);
                  const kindLabel =
                    kind === 'mobile'
                      ? t('webService.clientKindMobile')
                      : kind === 'web'
                        ? t('webService.clientKindWeb')
                        : t('webService.clientKindDesktop');
                  const connectedTime = formatConnectedAt(
                    device.last_connected_at ?? device.created_at
                  );
                  return (
                    <div
                      className="settings-pairing-devices__row flex min-h-10 min-w-0 items-center justify-between gap-3 px-3 py-2"
                      key={device.device_id}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                        <span className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-foreground">
                          {device.device_name}
                        </span>
                        <span className="settings-pairing-devices__preset shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {kindLabel}
                        </span>
                        {device.public_key_ed25519 ? (
                          <span
                            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                            title="已绑定 Ed25519 设备硬件公钥"
                          >
                            Ed25519
                          </span>
                        ) : null}
                        {device.ip_address ? (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                            {device.ip_address === 'webrtc'
                              ? 'WebRTC P2P'
                              : device.ip_address}
                          </span>
                        ) : null}
                        {connectedTime ? (
                          <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">
                            {connectedTime}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0 px-2.5 text-xs"
                          onClick={() => void revokeDevice(device)}
                          disabled={revokingId === device.device_id}
                        >
                          {revokingId === device.device_id ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          {t('webService.revokeDevice')}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
