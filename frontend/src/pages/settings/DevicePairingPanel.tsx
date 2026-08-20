import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, Copy, Loader2, QrCode, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
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
import { webServiceApi, type HostPairedDevice } from '@/lib/api';
import { getErrorMessage } from '@/lib/modals';
import type {
  BackendTransport,
  DevicePairingChallenge,
} from '@/lib/backendTransport';
import { cn } from '@/lib/utils';
import { SettingsSection } from './SettingsUi';
import {
  encodePairingInvitation,
  isLoopbackOrigin,
  PAIRING_TTL_SECONDS,
  pairingDisplayOrigins,
  pairingLiveStatus,
  pairingVisibleOrigins,
  type PairingReachability,
  type PairingTtlSeconds,
} from './pairingInvitation';

const PAIRING_QR_SIZE = 144;

type PairingPreset = 'companion' | 'workstation';

const EMPTY_HOST_URLS: string[] = [];
const EMPTY_REACHABILITY: PairingReachability[] = [];

export function DevicePairingPanel({
  transport,
  hostUrls = EMPTY_HOST_URLS,
  hostId,
  reachability = EMPTY_REACHABILITY,
  autoIssue = false,
  serviceRunning = true,
  onEnsureListening,
}: {
  transport: BackendTransport;
  hostUrls?: string[];
  hostId?: string | null;
  reachability?: PairingReachability[];
  autoIssue?: boolean;
  serviceRunning?: boolean;
  onEnsureListening?: () => Promise<string[]>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [preset, setPreset] = useState<PairingPreset>('companion');
  const [challenge, setChallenge] = useState<DevicePairingChallenge | null>(
    null
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoIssued, setAutoIssued] = useState(false);
  const [startedUrls, setStartedUrls] = useState<string[] | null>(null);
  const [devices, setDevices] = useState<HostPairedDevice[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [addressesExpanded, setAddressesExpanded] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState<PairingTtlSeconds>(300);
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
  const hasReachableOrigin = resolvedReachability.length > 0;

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await webServiceApi.listDevices());
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    const timer = window.setInterval(() => {
      void loadDevices();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadDevices]);

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
    async (ttl: PairingTtlSeconds = ttlSeconds) => {
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
              preset,
              ttl_seconds: ttl,
            })
          : await webServiceApi.createPairing(preset, ttl);
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
    () => pairingDisplayOrigins(resolvedReachability, resolvedUrls),
    [resolvedReachability, resolvedUrls]
  );
  const visibleOrigins = pairingVisibleOrigins(
    displayOrigins,
    addressesExpanded
  );
  const canExpandAddresses =
    displayOrigins.length > visibleOrigins.length ||
    (addressesExpanded && displayOrigins.length > 1);

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

  return (
    <SettingsSection
      icon={QrCode}
      title={t('webService.clientSectionTitle')}
      description={t('webService.clientSectionDescription')}
      className={!serviceRunning ? 'settings-remote-gated' : undefined}
    >
      <div className="settings-row">
        <Label htmlFor="pairing-preset">
          {t('webService.pairingPresetLabel')}
        </Label>
        <div className="flex items-center gap-2">
          <Select
            value={preset}
            onValueChange={(value) => setPreset(value as PairingPreset)}
          >
            <SelectTrigger
              id="pairing-preset"
              className="h-8 min-w-32 text-sm"
              aria-label={t('webService.pairingPresetLabel')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="companion">
                {t('webService.pairingPresetCompanion')}
              </SelectItem>
              <SelectItem value="workstation">
                {t('webService.pairingPresetWorkstation')}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => void createPairing()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <QrCode className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('webService.createPairing')}
          </Button>
        </div>
      </div>

      {!hasReachableOrigin ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {t('webService.pairingNeedsReachability')}
        </p>
      ) : null}

      {challenge ? (
        <div className="settings-pairing-body">
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
                        className="h-8 w-28 text-sm"
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
                      </SelectContent>
                    </Select>
                  </div>
                  <p
                    className={cn(
                      'settings-pairing-status',
                      liveStatus === 'connected' && 'settings-status-success',
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
          {displayOrigins.length > 0 ? (
            <div className="settings-pairing-addresses">
              {canExpandAddresses ? (
                <button
                  type="button"
                  className="settings-pairing-addresses__toggle"
                  aria-expanded={addressesExpanded}
                  aria-label={
                    addressesExpanded
                      ? t('webService.pairingAddressesCollapse')
                      : t('webService.pairingAddressesExpand')
                  }
                  onClick={() => setAddressesExpanded((current) => !current)}
                >
                  {t('webService.pairingAddressesLabel')}
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                      addressesExpanded && 'rotate-180'
                    )}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <p className="settings-pairing-addresses__label">
                  {t('webService.pairingAddressesLabel')}
                </p>
              )}
              {visibleOrigins.map((item) => (
                <div
                  className="settings-pairing-addresses__row"
                  key={item.origin}
                >
                  <p
                    className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                    title={item.origin}
                  >
                    {item.origin}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0"
                    onClick={() => void copyOrigin(item.origin)}
                    aria-label={`${t('webService.copyAddress')} ${item.origin}`}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('webService.pairingOneTime', {
              expiresAt: new Date(challenge.expires_at).toLocaleString(),
            })}
          </p>
        </div>
      ) : null}

      <div className="settings-pairing-devices">
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
          <div id={devicesListId} className="settings-pairing-devices__list">
            {devices.length === 0 ? (
              <p className="settings-pairing-devices__empty">
                {t('webService.pairedDevicesEmpty')}
              </p>
            ) : (
              devices.map((device) => (
                <div
                  className="settings-pairing-devices__row"
                  key={device.device_id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {device.device_name}
                    </p>
                    <p className="settings-row__description">
                      <span className="settings-pairing-devices__preset">
                        {device.preset === 'workstation'
                          ? t('webService.pairingPresetWorkstation')
                          : device.preset === 'companion'
                            ? t('webService.pairingPresetCompanion')
                            : t('webService.pairedDeviceUnknownPreset')}
                      </span>
                      {' · '}
                      {new Date(device.created_at).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => void revokeDevice(device)}
                    disabled={revokingId === device.device_id}
                  >
                    {revokingId === device.device_id ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('webService.revokeDevice')}
                  </Button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
