import { createContext, useContext, type ReactNode } from 'react';

type RightPanelSessionCreationContextValue = {
  openCreateSessionOverlay: () => void;
} | null;

const RightPanelSessionCreationContext =
  createContext<RightPanelSessionCreationContextValue>(null);

export function RightPanelSessionCreationProvider({
  value,
  children,
}: {
  value: RightPanelSessionCreationContextValue;
  children: ReactNode;
}) {
  return (
    <RightPanelSessionCreationContext.Provider value={value}>
      {children}
    </RightPanelSessionCreationContext.Provider>
  );
}

export function useRightPanelSessionCreation() {
  return useContext(RightPanelSessionCreationContext);
}
