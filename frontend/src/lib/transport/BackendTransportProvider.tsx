import {
  createContext,
  type PropsWithChildren,
  useContext,
  useLayoutEffect,
} from 'react';

import type { BackendTransport } from './backendTransport';
import { tauriBackendTransport } from './tauriTransport';
import {
  configureBackendTransport,
  getBackendTransport,
} from './transportRegistry';

const BackendTransportContext = createContext<BackendTransport>(
  tauriBackendTransport
);

export function BackendTransportProvider({
  transport,
  children,
}: PropsWithChildren<{ transport: BackendTransport }>) {
  useLayoutEffect(() => {
    const previousTransport = getBackendTransport();
    configureBackendTransport(transport);
    return () => configureBackendTransport(previousTransport);
  }, [transport]);

  return (
    <BackendTransportContext.Provider value={transport}>
      {children}
    </BackendTransportContext.Provider>
  );
}

export function useBackendTransport(): BackendTransport {
  return useContext(BackendTransportContext);
}
