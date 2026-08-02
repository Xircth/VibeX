import { type FormEvent, type ReactNode, useState } from 'react';

import { BackendTransportProvider, WebTransport } from '@/lib/transport';

export function WebTransportBootstrap({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrl] = useState(() => window.location.origin);
  const [token, setToken] = useState('');
  const [transport, setTransport] = useState<WebTransport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setConnecting(true);
    setError(null);
    const candidate = new WebTransport({
      baseUrl: baseUrl.trim() || window.location.origin,
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
          : 'Authentication failed. Check the Server URL and token.'
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
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-lg"
        onSubmit={(event) => void connect(event)}
        aria-label="Connect to VibeX Server"
      >
        <div>
          <h1 className="text-xl font-semibold">VibeX Web</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect with the token shown by vibex-server.
          </p>
        </div>
        <label className="block space-y-1 text-sm">
          <span>Server URL</span>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoComplete="url"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Server token</span>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <button
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          type="submit"
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </main>
  );
}

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}
