import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  ConversationError,
  ConversationPermissionView,
  ConversationQuestionRequest,
  ConversationSessionNotice,
} from 'shared/types';

export type ConversationStatusNotice =
  | {
      id: string;
      kind: 'turn-error';
      error: ConversationError;
      onReload?: () => void | Promise<unknown>;
      onRebind?: () => void | Promise<unknown>;
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
      onRebind?: () => void | Promise<unknown>;
      onReload?: () => void | Promise<unknown>;
      onNewConversation?: () => void | Promise<unknown>;
    };

export type PendingConversationQuestion = {
  request: ConversationQuestionRequest;
  responding: boolean;
  onRespond: (questionId: string, response: AgentElicitationResponse) => void;
};

export type PendingConversationPermission = {
  request: ConversationPermissionView;
  responding: boolean;
  onRespond: (permissionId: string, response: AgentPermissionResponse) => void;
};

export type ConversationChildrenDock = {
  conversationId: string;
  onOpenChild?: (conversationId: string, workspaceId?: string) => void;
};

type ConversationStatusContextValue = {
  enabled: boolean;
  notices: ConversationStatusNotice[];
  setNotices: (notices: ConversationStatusNotice[]) => void;
  sessionBindReady: boolean;
  setSessionBindReady: (ready: boolean) => void;
  question: PendingConversationQuestion | null;
  setQuestion: (question: PendingConversationQuestion | null) => void;
  permissions: PendingConversationPermission[];
  setPermissions: (permissions: PendingConversationPermission[]) => void;
  childrenDock: ConversationChildrenDock | null;
  setChildrenDock: (dock: ConversationChildrenDock | null) => void;
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
  const [sessionBindReady, setSessionBindReady] = useState(false);
  const [question, setQuestion] = useState<PendingConversationQuestion | null>(
    null
  );
  const [permissions, setPermissions] = useState<
    PendingConversationPermission[]
  >([]);
  const [childrenDock, setChildrenDock] =
    useState<ConversationChildrenDock | null>(null);
  const value = useMemo(
    () => ({
      enabled,
      notices,
      setNotices,
      sessionBindReady,
      setSessionBindReady,
      question,
      setQuestion,
      permissions,
      setPermissions,
      childrenDock,
      setChildrenDock,
    }),
    [childrenDock, enabled, notices, permissions, question, sessionBindReady]
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
