import { createContext, useContext, type ReactNode } from 'react';

export type SessionSurfaceChrome = {
  composerIdentity?: ReactNode;
  hidePersonaHostNotes?: boolean;
};

const SessionSurfaceChromeContext = createContext<SessionSurfaceChrome>({});

export function SessionSurfaceChromeProvider({
  value,
  children,
}: {
  value: SessionSurfaceChrome;
  children: ReactNode;
}) {
  return (
    <SessionSurfaceChromeContext.Provider value={value}>
      {children}
    </SessionSurfaceChromeContext.Provider>
  );
}

export function useSessionSurfaceChrome(): SessionSurfaceChrome {
  return useContext(SessionSurfaceChromeContext);
}
