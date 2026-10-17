import { createContext, useContext } from 'react';

import type { PersistedBasicGuide } from './basicGuideState';

export type BasicGuideContextValue = {
  state: PersistedBasicGuide;
  continueStep: () => void;
  requestExit: () => void;
  confirmExit: () => void;
  cancelExit: () => void;
  finish: () => void;
  restart: () => void;
  start: () => void;
  skip: () => void;
  dismissEnd: () => void;
  exitOpen: boolean;
};

export const BasicGuideContext = createContext<BasicGuideContextValue | null>(
  null
);

export function useBasicGuide(): BasicGuideContextValue {
  const value = useContext(BasicGuideContext);
  if (!value) {
    throw new Error('useBasicGuide must be used within BasicGuideProvider');
  }
  return value;
}

export function useOptionalBasicGuide(): BasicGuideContextValue | null {
  return useContext(BasicGuideContext);
}
