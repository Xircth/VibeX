import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Logo } from '@/components/Logo';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import { BackendTransportProvider, WebTransport } from '@/lib/transport';
import {
  defaultHostUrl,
  explicitHostUrl,
  looksLikeVibexHost,
} from '@/pages/settings/hostEndpoints';
import '@/styles/legacy/index.css';

export function WebTransportBootstrap({ children }: { children: ReactNode }) {
  const { t } = useTranslation('app');
  const [baseUrl, setBaseUrl] = useState(() =>
    defaultHostUrl(window.location.origin, window.location.search)
  );
  const [token, setToken] = useState('');
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [transport, setTransport] = useState<WebTransport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const hostDiffers = useMemo(() => {
    try {
      return (
        Boolean(baseUrl) && new URL(baseUrl).origin !== window.location.origin
      );
    } catch {
      return false;
    }
  }, [baseUrl]);

  useEffect(() => {
    if (explicitHostUrl(window.location.search)) return;
    let active = true;
    void looksLikeVibexHost(window.location.origin).then((isHost) => {
      if (active && !isHost) setBaseUrl('');
    });
    return () => {
      active = false;
    };
  }, []);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const host = baseUrl.trim();
    if (!token.trim() || !host) return;
    setConnecting(true);
    setError(null);
    if (!(await looksLikeVibexHost(host))) {
      setError(t('webConnect.notAHost'));
      setConnecting(false);
      return;
    }
    const candidate = new WebTransport({
      baseUrl: host,
      token: token.trim(),
    });
    try {
      await candidate.capabilities();
      setToken('');
      setTransport(candidate);
    } catch (nextError) {
      candidate.destroy();
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('webConnect.authFailed')
      );
    } finally {
      setConnecting(false);
    }
  };

  if (transport) {
    return (
      <BackendTransportProvider transport={transport}>
        {children}
      </BackendTransportProvider>
    );
  }

  return (
    <div className="legacy-design web-connect">
      <main className="web-connect__frame">
        <form
          className="web-connect__card"
          onSubmit={(event) => void connect(event)}
          aria-label={t('webConnect.formLabel')}
        >
          <div className="web-connect__brand">
            <Logo showText size="window" />
          </div>
          <div className="web-connect__intro">
            <h1 className="web-connect__title">{t('webConnect.title')}</h1>
            <p className="web-connect__description">
              {t('webConnect.description')}
            </p>
          </div>
          <label className="web-connect__field">
            <span>{t('webConnect.hostLabel')}</span>
            <TextInput
              label={t('webConnect.hostLabel')}
              isLabelHidden
              value={baseUrl}
              onChange={setBaseUrl}
              isRequired
              placeholder="http://127.0.0.1:17891"
              width="100%"
              className="[&_input]:font-mono [&_input]:text-sm"
            />
            {hostDiffers ? (
              <span className="web-connect__hint">
                {t('webConnect.hostMismatch')}
              </span>
            ) : null}
          </label>
          <label className="web-connect__field">
            <span>{t('webConnect.tokenLabel')}</span>
            <span className="web-connect__token">
              <TextInput
                label={t('webConnect.tokenLabel')}
                isLabelHidden
                type={tokenRevealed ? 'text' : 'password'}
                value={token}
                onChange={setToken}
                isRequired
                hasAutoFocus
                width="100%"
                className="[&_input]:font-mono [&_input]:text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="web-connect__reveal"
                onClick={() => setTokenRevealed((value) => !value)}
                aria-label={
                  tokenRevealed
                    ? t('webConnect.hideToken')
                    : t('webConnect.showToken')
                }
              >
                {tokenRevealed ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </span>
          </label>
          {error ? (
            <p role="alert" className="web-connect__error">
              {error}
            </p>
          ) : null}
          <Button
            className="w-full"
            type="submit"
            disabled={connecting || !token.trim() || !baseUrl.trim()}
          >
            {connecting ? t('webConnect.connecting') : t('webConnect.connect')}
          </Button>
        </form>
      </main>
    </div>
  );
}
