import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, QrCode, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type {
  BackendTransport,
  DevicePairingChallenge,
} from '@/lib/backendTransport';

const DEFAULT_DEVICE_SCOPES = ['conversation.read', 'conversation.question'];

export function DevicePairingPanel({
  transport,
}: {
  transport: BackendTransport;
}) {
  const { t } = useTranslation('settings');
  const [challenge, setChallenge] = useState<DevicePairingChallenge | null>(
    null
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!challenge) {
      setQrDataUrl(null);
      return;
    }
    let active = true;
    const payload = JSON.stringify({
      version: 1,
      pairing_id: challenge.pairing_id,
      pairing_token: challenge.pairing_token,
      expires_at: challenge.expires_at,
    });
    void QRCode.toDataURL(`vibex-pairing:${payload}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 224,
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl);
    });
    return () => {
      active = false;
    };
  }, [challenge]);

  const createPairing = useCallback(async () => {
    if (!transport.createDevicePairing) return;
    setBusy(true);
    try {
      setChallenge(
        await transport.createDevicePairing({
          requested_scopes: DEFAULT_DEVICE_SCOPES,
        })
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('webService.pairingFailed')
      );
    } finally {
      setBusy(false);
    }
  }, [t, transport]);

  const copyToken = useCallback(async () => {
    if (!challenge) return;
    await navigator.clipboard.writeText(challenge.pairing_token);
    toast.success(t('webService.pairingCopied'));
  }, [challenge, t]);

  if (
    transport.environment !== 'web' ||
    typeof transport.createDevicePairing !== 'function'
  ) {
    return null;
  }

  return (
    <div className="settings-surface overflow-hidden">
      <div className="settings-row">
        <div>
          <h3 className="text-sm font-semibold">
            {t('webService.pairingTitle')}
          </h3>
          <p className="settings-row__description">
            {t('webService.pairingDescription')}
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => void createPairing()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <QrCode className="mr-1 h-3.5 w-3.5" />
          )}
          {t('webService.createPairing')}
        </Button>
      </div>

      {challenge ? (
        <div className="flex flex-wrap items-start gap-4 px-4 py-4">
          <div className="rounded-[10px] bg-white p-2">
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
            <div>
              <p className="text-xs font-medium">
                {t('webService.pairingCodeLabel')}
              </p>
              <code className="mt-1 block break-all rounded-md bg-muted px-2 py-1.5 text-xs">
                {challenge.pairing_token}
              </code>
            </div>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('webService.pairingOneTime', {
                expiresAt: new Date(challenge.expires_at).toLocaleString(),
              })}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void copyToken()}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {t('webService.copyPairingCode')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
