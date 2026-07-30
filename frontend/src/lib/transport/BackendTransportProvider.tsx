import { createContext, type PropsWithChildren, useContext } from 'react';

import type { BackendTransport } from './BackendTransport';
import { tauriBackendTransport } from './TauriTransport';

const BackendTransportContext = createContext<BackendTransport>(
  tauriBackendTransport
);

export function BackendTransportProvider({
  transport,
  children,
}: PropsWithChildren<{ transport: BackendTransport }>) {
  return (
    <BackendTransportContext.Provider value={transport}>
      {children}
    </BackendTransportContext.Provider>
  );
}

export function useBackendTransport(): BackendTransport {
  return useContext(BackendTransportContext);
}
