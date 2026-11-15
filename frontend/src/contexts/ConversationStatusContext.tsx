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
import type { RateLimitIndicatorState } from '@/components/NormalizedConversation/RateLimitRecoveryBanner';

export type ConversationStatusNotice =
  | {
      id: string;
      kind: 'turn-error';
      error: ConversationError;
      onReload?: () => void | Promise<unknown>;
      onRebind?: () => void | Promise<unknown>;
      onRetry?: () => void | Promise<unknown>;
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
      titleOverride?: string | null;
      onCancel?: () => void | Promise<unknown>;
      onRetry?: () => void | Promise<unknown>;
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

export type ActiveConversationRateLimit = {
  conversationId: string;
  state: RateLimitIndicatorState;
  onUpdateAutoResume: (params: {
    conversationId: string;
    autoResume: boolean;
    continuationPrompt: string;
  }) => Promise<void> | void;
  onCancelWait: (conversationId: string) => Promise<void> | void;
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
  rateLimit: ActiveConversationRateLimit | null;
  setRateLimit: (rateLimit: ActiveConversationRateLimit | null) => void;
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
  const [rateLimit, setRateLimit] =
    useState<ActiveConversationRateLimit | null>(null);
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
      rateLimit,
      setRateLimit,
    }),
    [
      childrenDock,
      enabled,
      notices,
      permissions,
      question,
      rateLimit,
      sessionBindReady,
    ]
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
