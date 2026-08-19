import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Loader2, QrCode, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';

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
import { webServiceApi } from '@/lib/api';
import type {
  BackendTransport,
  DevicePairingChallenge,
} from '@/lib/backendTransport';
import { SettingsSection } from './SettingsUi';
import {
  encodePairingInvitation,
  isLoopbackOrigin,
  type PairingReachability,
} from './pairingInvitation';

type PairingPreset = 'companion' | 'workstation';

const EMPTY_HOST_URLS: string[] = [];
const EMPTY_REACHABILITY: PairingReachability[] = [];

export function DevicePairingPanel({
  transport,
  hostUrls = EMPTY_HOST_URLS,
  hostId,
  reachability = EMPTY_REACHABILITY,
  autoIssue = false,
  onEnsureListening,
}: {
  transport: BackendTransport;
  hostUrls?: string[];
  hostId?: string | null;
  reachability?: PairingReachability[];
  autoIssue?: boolean;
  onEnsureListening?: () => Promise<string[]>;
}) {
  const { t } = useTranslation('settings');
  const [preset, setPreset] = useState<PairingPreset>('companion');
  const [challenge, setChallenge] = useState<DevicePairingChallenge | null>(
    null
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoIssued, setAutoIssued] = useState(false);
  const [startedUrls, setStartedUrls] = useState<string[] | null>(null);
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

  useEffect(() => {
    if (!invitation) {
      setQrDataUrl(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(invitation, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 224,
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl);
    });
    return () => {
      active = false;
    };
  }, [invitation]);

  const createPairing = useCallback(async () => {
    setBusy(true);
    try {
      if (onEnsureListening) {
        setStartedUrls(await onEnsureListening());
      }
      const created = transport.createDevicePairing
        ? await transport.createDevicePairing({ preset })
        : await webServiceApi.createPairing(preset);
      setChallenge(created);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.pairingFailed')
      );
    } finally {
      setBusy(false);
    }
  }, [onEnsureListening, preset, t, transport]);

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

  const copyConnectionCode = useCallback(async () => {
    if (!connectionCode) return;
    await navigator.clipboard.writeText(connectionCode);
    toast.success(t('webService.pairingCopied'));
  }, [connectionCode, t]);

  return (
    <SettingsSection
      icon={QrCode}
      title={t('webService.pairingTitle')}
      description={t('webService.pairingDescription')}
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
        <div className="flex flex-wrap items-start gap-4 px-4 pb-4">
          <div className="rounded-lg bg-white p-2">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                width={224}
                height={224}
                alt={t('webService.pairingQrAlt')}
              />
            ) : (
              <div
                className="flex h-56 w-56 items-center justify-center text-muted-foreground"
                aria-label={t('webService.pairingQrLoading')}
              >
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            {connectionCode ? (
              <div>
                <p className="text-sm font-medium">
                  {t('webService.pairingCodeLabel')}
                </p>
                <code className="mt-1 block tracking-[0.28em] rounded-md bg-muted px-3 py-2 text-2xl font-semibold">
                  {connectionCode}
                </code>
              </div>
            ) : null}
            {resolvedReachability.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {resolvedReachability.map((item) => item.origin).join(' · ')}
              </p>
            ) : null}
            <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('webService.pairingOneTime', {
                expiresAt: new Date(challenge.expires_at).toLocaleString(),
              })}
            </p>
            {connectionCode ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyConnectionCode()}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {t('webService.copyPairingCode')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
