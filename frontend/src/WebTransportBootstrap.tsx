import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BackendTransportProvider, WebTransport } from '@/lib/transport';
import { WebTransportError } from '@/lib/transport/webTransport';
import {
  defaultHostUrl,
  explicitHostUrl,
  looksLikeVibexHost,
} from '@/pages/settings/hostEndpoints';
import '@/styles/legacy/index.css';

const PAIRING_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;
const WEB_SESSION_STORAGE_KEY = 'vibex.web_session';
export const WEB_SESSION_DISCONNECT_EVENT = 'vibex:web-disconnect';

interface StoredWebSession {
  baseUrl: string;
  token: string;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function readStoredWebSession(): StoredWebSession | null {
  try {
    const raw = window.sessionStorage.getItem(WEB_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWebSession> | null;
    if (
      typeof parsed?.baseUrl === 'string' &&
      parsed.baseUrl.trim() &&
      typeof parsed?.token === 'string' &&
      parsed.token.trim()
    ) {
      return {
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        token: parsed.token.trim(),
      };
    }
    window.sessionStorage.removeItem(WEB_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage access or JSON parse errors.
  }
  return null;
}

function writeStoredWebSession(session: StoredWebSession): void {
  try {
    window.sessionStorage.setItem(
      WEB_SESSION_STORAGE_KEY,
      JSON.stringify({
        baseUrl: normalizeBaseUrl(session.baseUrl),
        token: session.token,
      })
    );
  } catch {
    // Ignore storage write errors in restricted browser contexts.
  }
}

function clearStoredWebSession(): void {
  try {
    window.sessionStorage.removeItem(WEB_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function getRestorableWebSession(): StoredWebSession | null {
  if (typeof window === 'undefined') return null;
  const stored = readStoredWebSession();
  if (!stored) return null;
  const explicit = explicitHostUrl(window.location.search);
  if (
    explicit &&
    normalizeBaseUrl(explicit) !== normalizeBaseUrl(stored.baseUrl)
  ) {
    return null;
  }
  return stored;
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof WebTransportError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.code === 'unauthorized' ||
      error.code === 'forbidden'
    );
  }
  return false;
}

export function disconnectWebSession(): void {
  clearStoredWebSession();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WEB_SESSION_DISCONNECT_EVENT));
  }
}

function extractPairingCode(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith('vibex-pairing:')) {
    try {
      const parsed = JSON.parse(raw.slice('vibex-pairing:'.length)) as {
        pairing_token?: unknown;
      };
      if (
        typeof parsed.pairing_token === 'string' &&
        parsed.pairing_token.trim()
      ) {
        return parsed.pairing_token
          .trim()
          .replace(/[\s-]+/g, '')
          .toUpperCase();
      }
    } catch {
      return null;
    }
  }
  const canonical = raw.replace(/[\s-]+/g, '').toUpperCase();
  return PAIRING_CODE_PATTERN.test(canonical) ? canonical : null;
}

function detectBrowserDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Edg\//i.test(ua)) return 'Edge (Web)';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome (Web)';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari (Web)';
  if (/Firefox\//i.test(ua)) return 'Firefox (Web)';
  return 'VibeX Web';
}

export function WebTransportBootstrap({ children }: { children: ReactNode }) {
  const { t } = useTranslation('app');
  const tRef = useRef(t);
  tRef.current = t;
  const [initialSession] = useState<StoredWebSession | null>(() =>
    getRestorableWebSession()
  );
  const [baseUrl, setBaseUrl] = useState(
    () =>
      initialSession?.baseUrl ??
      defaultHostUrl(window.location.origin, window.location.search)
  );
  const [token, setToken] = useState('');
  const [tokenRevealed, setTokenRevealed] = useState(true);
  const [transport, setTransport] = useState<WebTransport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(() => Boolean(initialSession));
  const hostDiffers = useMemo(() => {
    try {
      return (
        Boolean(baseUrl) && new URL(baseUrl).origin !== window.location.origin
      );
    } catch {
      return false;
    }
  }, [baseUrl]);

  const createTransport = useCallback(
    (host: string, resolvedToken: string) => {
      const candidate = new WebTransport({
        baseUrl: host,
        token: resolvedToken,
        onAuthError: (authError) => {
          clearStoredWebSession();
          candidate.destroy();
          setTransport((current) => (current === candidate ? null : current));
          setError(authError.message || tRef.current('webConnect.authFailed'));
        },
      });
      return candidate;
    },
    []
  );

  useEffect(() => {
    const handleDisconnect = () => {
      clearStoredWebSession();
      setError(null);
      setTransport((current) => {
        current?.destroy();
        return null;
      });
    };
    window.addEventListener(WEB_SESSION_DISCONNECT_EVENT, handleDisconnect);
    return () => {
      window.removeEventListener(
        WEB_SESSION_DISCONNECT_EVENT,
        handleDisconnect
      );
    };
  }, []);

  useEffect(() => {
    if (!initialSession) {
      if (explicitHostUrl(window.location.search)) return;
      let active = true;
      void looksLikeVibexHost(window.location.origin).then((isHost) => {
        if (active && !isHost) setBaseUrl('');
      });
      return () => {
        active = false;
      };
    }

    let active = true;
    const candidate = createTransport(
      initialSession.baseUrl,
      initialSession.token
    );
    void candidate
      .capabilities()
      .then(() => {
        if (!active) {
          candidate.destroy();
          return;
        }
        writeStoredWebSession(initialSession);
        setError(null);
        setTransport(candidate);
      })
      .catch((nextError) => {
        candidate.destroy();
        if (!active) return;
        if (isAuthFailure(nextError)) {
          clearStoredWebSession();
        }
        setError(
          nextError instanceof Error && nextError.message
            ? nextError.message
            : tRef.current('webConnect.authFailed')
        );
      })
      .finally(() => {
        if (active) {
          setRestoring(false);
        }
      });

    return () => {
      active = false;
    };
  }, [createTransport, initialSession]);

  const connect = async (event: SyntheticEvent) => {
    event.preventDefault();
    const host = normalizeBaseUrl(baseUrl);
    const rawToken = token.trim();
    if (!rawToken || !host) return;
    setConnecting(true);
    setError(null);
    if (!(await looksLikeVibexHost(host))) {
      setError(t('webConnect.notAHost'));
      setConnecting(false);
      return;
    }
    let resolvedToken = rawToken;
    const pairingCode = extractPairingCode(rawToken);
    if (pairingCode) {
      try {
        const response = await fetch(`${host}/api/v1/auth/pairings/redeem`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-vibex-protocol-version': '1.0',
          },
          body: JSON.stringify({
            pairing_token: pairingCode,
            device_name: detectBrowserDeviceName(),
          }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(payload?.message || t('webConnect.authFailed'));
        }
        const credential = (await response.json()) as {
          access_token?: string;
          device_token?: string;
        };
        const issuedToken =
          credential?.access_token ?? credential?.device_token;
        if (!issuedToken) {
          throw new Error(t('webConnect.authFailed'));
        }
        resolvedToken = issuedToken;
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : t('webConnect.authFailed')
        );
        setConnecting(false);
        return;
      }
    }
    const candidate = createTransport(host, resolvedToken);
    try {
      await candidate.capabilities();
      writeStoredWebSession({ baseUrl: host, token: resolvedToken });
      setToken('');
      setTransport(candidate);
    } catch (nextError) {
      candidate.destroy();
      if (isAuthFailure(nextError)) {
        clearStoredWebSession();
      }
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

  if (restoring) {
    return (
      <div className="legacy-design web-connect">
        <main className="web-connect__frame">
          <div className="web-connect__card" role="status" aria-live="polite">
            <div className="web-connect__brand">
              <Logo showText size="window" />
            </div>
            <div className="web-connect__intro">
              <h1 className="web-connect__title">{t('webConnect.title')}</h1>
              <p className="web-connect__description">
                {t('webConnect.connecting')}
              </p>
            </div>
          </div>
        </main>
      </div>
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
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              required
              placeholder="http://127.0.0.1:17891"
              className="font-mono text-sm"
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
              <Input
                type={tokenRevealed ? 'text' : 'password'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={t('webConnect.tokenPlaceholder')}
                required
                autoFocus
                className="flex-1 font-mono text-sm"
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
