import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { hostClientApi } from '@/lib/api';
import {
  BackendTransportProvider,
  RemoteDesktopTransport,
  tauriBackendTransport,
  type BackendTransport,
} from '@/lib/transport';
import { BoundHostTransport } from '@/lib/transport/boundHostTransport';
import { getAppRouteMode } from './appRouteMode';
import { isTauriRuntime } from './WebTransportBootstrap';

const HOST_CLIENT_CHANGED = 'host-client-changed';

function shouldBindAppShell(): boolean {
  return (
    isTauriRuntime() &&
    getAppRouteMode(window.location.pathname) !== 'desktop-toast'
  );
}

export function DesktopHostBootstrap({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const bindShell = shouldBindAppShell();
  const [transport, setTransport] = useState<BackendTransport>(
    tauriBackendTransport
  );

  useEffect(() => {
    if (!bindShell) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let boundOrigin: string | null = null;

    const apply = async () => {
      try {
        const status = await hostClientApi.status();
        if (cancelled) return;
        const nextOrigin =
          status.connected && status.profile?.origin
            ? status.profile.origin
            : null;
        if (nextOrigin === boundOrigin) return;
        boundOrigin = nextOrigin;
        queryClient.clear();
        if (nextOrigin) {
          const remote = RemoteDesktopTransport.attach({
            profileId: 'active-host-client',
            baseUrl: nextOrigin,
          });
          setTransport(new BoundHostTransport(remote));
        } else {
          setTransport(tauriBackendTransport);
        }
      } catch {
        if (!cancelled && boundOrigin == null) {
          setTransport(tauriBackendTransport);
        }
      }
    };

    void apply();
    void import('@/lib/tauriApi').then(({ tauriListen }) =>
      tauriListen(HOST_CLIENT_CHANGED, () => {
        void apply();
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
    );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bindShell, queryClient]);

  if (!bindShell) {
    return children;
  }

  return (
    <BackendTransportProvider transport={transport}>
      {children}
    </BackendTransportProvider>
  );
}
