import { CheckCircle2, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexDeviceCodeView } from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

type LoginStatus = 'idle' | 'requesting' | 'polling' | 'success' | 'error';

type Props = {
  onAuthenticated?: () => void | Promise<void>;
};

export function CodexDeviceLogin({ onAuthenticated }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [deviceCode, setDeviceCode] = useState<CodexDeviceCodeView | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const beginLogin = useCallback(async () => {
    cancelled.current = false;
    setStatus('requesting');
    setError(null);
    setDeviceCode(null);
    try {
      const code = await agentManagementApi.requestCodexDeviceCode();
      if (cancelled.current) return;
      setDeviceCode(code);
      setStatus('polling');
    } catch (requestError) {
      if (cancelled.current) return;
      setError(
        errorMessage(
          requestError,
          t('settings:agents.codexDeviceRequestFailed')
        )
      );
      setStatus('error');
    }
  }, [t]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    setStatus('idle');
    setDeviceCode(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (status !== 'polling' || !deviceCode) return;
    cancelled.current = false;
    const interval = Math.max(1, deviceCode.interval || 5) * 1000;
    const deadline = Date.now() + 15 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const poll = async () => {
      if (!active || cancelled.current) return;
      if (Date.now() > deadline) {
        setError(t('settings:agents.codexDeviceTimedOut'));
        setStatus('error');
        setDeviceCode(null);
        return;
      }
      try {
        const result = await agentManagementApi.pollCodexDeviceCode(
          deviceCode.device_auth_id,
          deviceCode.user_code
        );
        if (!active || cancelled.current) return;
        if (result.status === 'success') {
          setStatus('success');
          setDeviceCode(null);
          await onAuthenticated?.();
          return;
        }
        if (result.status === 'error') {
          setError(
            result.message ?? t('settings:agents.codexDeviceLoginFailed')
          );
          setStatus('error');
          setDeviceCode(null);
          return;
        }
      } catch {
        // Transient network failures keep the bounded polling flow alive.
      }
      timer = setTimeout(() => void poll(), interval);
    };

    timer = setTimeout(() => void poll(), interval);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [deviceCode, onAuthenticated, status, t]);

  if (status === 'idle') {
    return (
      <div className="codex-device-login">
        <div>
          <strong>{t('settings:agents.codexDeviceTitle')}</strong>
        </div>
        <Button
          aria-label={t('settings:agents.codexDeviceLoginAria')}
          className="h-8 shrink-0"
          size="sm"
          variant="outline"
          onClick={() => void beginLogin()}
        >
          {t('settings:agents.codexDeviceLogin')}
        </Button>
      </div>
    );
  }

  return (
    <div aria-live="polite" className="codex-device-login is-active">
      {status === 'requesting' ? (
        <div className="codex-device-status">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          <span>{t('settings:agents.codexDeviceRequesting')}</span>
          <Button
            className="ml-auto h-8"
            size="sm"
            variant="ghost"
            onClick={cancel}
          >
            {t('common:cancel')}
          </Button>
        </div>
      ) : null}

      {status === 'polling' && deviceCode ? (
        <div className="codex-device-flow">
          <div>
            <span>{t('settings:agents.codexDeviceStepOpen')}</span>
            <Button
              className="h-8"
              size="sm"
              variant="outline"
              onClick={() => void openExternalUrl(deviceCode.verification_url)}
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              {t('settings:agents.codexDeviceOpenPage')}
            </Button>
          </div>
          <div>
            <span>{t('settings:agents.codexDeviceStepEnter')}</span>
            <div className="codex-device-code">
              <code>{deviceCode.user_code}</code>
              <Button
                aria-label={t('settings:agents.codexDeviceCopyAria')}
                className="h-8 w-8 p-0"
                size="sm"
                variant="ghost"
                onClick={() => void copyCode(deviceCode.user_code, t)}
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="codex-device-waiting">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            <span>{t('settings:agents.codexDeviceWaiting')}</span>
          </div>
          <Button className="h-8" size="sm" variant="ghost" onClick={cancel}>
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            {t('common:cancel')}
          </Button>
        </div>
      ) : null}

      {status === 'success' ? (
        <div className="codex-device-status is-success">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <span>{t('settings:agents.codexDeviceSuccess')}</span>
          <Button className="h-8" size="sm" variant="ghost" onClick={cancel}>
            {t('settings:agents.done')}
          </Button>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="codex-device-error" role="alert">
          <div>
            <strong>{t('settings:agents.codexDeviceIncomplete')}</strong>
            <p>{error}</p>
          </div>
          <Button
            className="h-8 shrink-0"
            size="sm"
            variant="outline"
            onClick={() => void beginLogin()}
          >
            {t('settings:agents.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

async function copyCode(
  code: string,
  t: ReturnType<typeof useTranslation>['t']
): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast.success(t('settings:agents.codexDeviceCopied'));
  } catch {
    toast.error(t('settings:agents.codexDeviceCopyFailed'));
  }
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
