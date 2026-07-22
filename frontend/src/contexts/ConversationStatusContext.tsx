import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  ConversationError,
  ConversationSessionNotice,
} from 'shared/types';

export type ConversationStatusNotice =
  | {
      id: string;
      kind: 'turn-error';
      error: ConversationError;
      onReload?: () => void | Promise<unknown>;
    }
  | {
      id: string;
      kind: 'interrupted-turn';
      onResend?: () => void;
    }
  | {
      id: string;
      kind: 'session-notice';
      notice: ConversationSessionNotice;
    };

type ConversationStatusContextValue = {
  enabled: boolean;
  notices: ConversationStatusNotice[];
  setNotices: (notices: ConversationStatusNotice[]) => void;
};

const ConversationStatusContext =
  createContext<ConversationStatusContextValue | null>(null);

export function ConversationStatusProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const [notices, setNotices] = useState<ConversationStatusNotice[]>([]);
  const value = useMemo(
    () => ({ enabled, notices, setNotices }),
    [enabled, notices]
  );

  return (
    <ConversationStatusContext.Provider value={value}>
      {children}
    </ConversationStatusContext.Provider>
  );
}

export function useConversationStatus(): ConversationStatusContextValue {
  const context = useContext(ConversationStatusContext);
  if (!context) {
    throw new Error(
      'useConversationStatus must be used within a ConversationStatusProvider'
    );
  }
  return context;
}

export function useOptionalConversationStatus(): ConversationStatusContextValue | null {
  return useContext(ConversationStatusContext);
}
