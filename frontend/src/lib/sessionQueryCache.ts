import type { QueryClient } from '@tanstack/react-query';
import type { Session } from 'shared/types';
import { syncConversationSelectedAgent } from '@/features/conversation/conversationTimelineRegistry';
import type { SessionSummary } from '@/lib/api';
import { normalizeAgentGroupKey } from '@/lib/providerInstancesApi';
import type { WorkspaceWithSession } from '@/types/attempt';

export const WORKSPACE_SESSIONS_CHANGED_EVENT = 'workspace-sessions-changed';
export const SESSION_AGENT_SWITCHED_EVENT = 'dimo:session-agent-switched';

export type WorkspaceSessionsChangedPayload = {
  workspace_id: string;
  conversation_id: string;
};

export type SessionAgentSwitchedDetail = {
  sessionId: string;
  agentId: string;
  executor: string;
  providerInstanceId?: string | null;
};

export function canonicalSessionAgentId(rawAgent: string): string {
  const trimmed = rawAgent.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed.toLowerCase().replace(/-/g, '_');
  }
  return trimmed;
}

function normalizeCacheInstanceId(
  raw: string | null | undefined
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'local') return null;
  return trimmed;
}

export function syncSessionAgentInCaches(
  queryClient: QueryClient | null | undefined,
  sessionId: string | null | undefined,
  rawExecutor: string | null | undefined,
  rawProviderInstanceId?: string | null
): void {
  const id = sessionId?.trim();
  const executor = rawExecutor?.trim();
  if (!id || !executor) return;
  const agentId = canonicalSessionAgentId(executor);
  if (!agentId) return;
  const targetGroup = normalizeAgentGroupKey(agentId);
  const nextInstanceId = normalizeCacheInstanceId(rawProviderInstanceId);
  const hasInstanceUpdate = nextInstanceId !== undefined;

  syncConversationSelectedAgent(id, agentId);

  if (queryClient) {
    queryClient.setQueriesData<Array<Record<string, unknown>>>(
      { queryKey: ['workspaceSessions'] },
      (current) => {
        if (!Array.isArray(current)) return current;
        let touched = false;
        const next = current.map((item) => {
          if (item?.id !== id) return item;
          const prevAgent =
            (typeof item.agent_id === 'string' && item.agent_id) ||
            (typeof item.executor === 'string' && item.executor) ||
            '';
          const agentChanged = normalizeAgentGroupKey(prevAgent) !== targetGroup;
          const currentInstance =
            typeof item.provider_instance_id === 'string'
              ? item.provider_instance_id
              : null;
          const instanceChanged =
            hasInstanceUpdate && currentInstance !== nextInstanceId;
          if (
            item.agent_id === agentId &&
            item.executor === agentId &&
            (!agentChanged || item.model == null) &&
            !instanceChanged
          ) {
            return item;
          }
          touched = true;
          return {
            ...item,
            agent_id: agentId,
            executor: agentId,
            ...('model' in item && (agentChanged || instanceChanged)
              ? { model: null }
              : {}),
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          };
        });
        return touched ? next : current;
      }
    );

    queryClient.setQueryData<Session | undefined>(['session', id], (current) =>
      current
        ? {
            ...current,
            agent_id: agentId,
            executor: agentId,
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          }
        : current
    );

    queryClient.setQueriesData<WorkspaceWithSession>(
      { queryKey: ['taskAttemptWithSession'] },
      (current) => {
        if (!current?.session || current.session.id !== id) return current;
        return {
          ...current,
          session: {
            ...current.session,
            agent_id: agentId,
            executor: agentId,
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          },
        };
      }
    );

    queryClient.setQueriesData<Array<Record<string, unknown>>>(
      { queryKey: ['collaboration', 'conversations'] },
      (current) => {
        if (!Array.isArray(current)) return current;
        let touched = false;
        const next = current.map((item) => {
          const itemId = item?.id ?? item?.conversation_id;
          const currentInstance =
            typeof item?.provider_instance_id === 'string'
              ? item.provider_instance_id
              : null;
          const instanceChanged =
            hasInstanceUpdate && currentInstance !== nextInstanceId;
          if (itemId !== id || (item.agent_id === agentId && !instanceChanged)) {
            return item;
          }
          touched = true;
          return {
            ...item,
            agent_id: agentId,
            ...(hasInstanceUpdate
              ? { provider_instance_id: nextInstanceId }
              : {}),
          };
        });
        return touched ? next : current;
      }
    );

    queryClient.setQueriesData<Array<Record<string, unknown>> | null>(
      { queryKey: ['collaboration', 'sidebar'] },
      (current) => {
        if (!Array.isArray(current)) return current;
        let touched = false;
        const next = current.map((item) => {
          const member = item?.member as Record<string, unknown> | undefined;
          if (!member || member.conversation_id !== id) return item;
          if (member.agent === agentId && member.agent_id === agentId) {
            return item;
          }
          touched = true;
          return {
            ...item,
            member: {
              ...member,
              ...('agent' in member ? { agent: agentId } : {}),
              ...('agent_id' in member ? { agent_id: agentId } : {}),
            },
          };
        });
        return touched ? next : current;
      }
    );
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<SessionAgentSwitchedDetail>(SESSION_AGENT_SWITCHED_EVENT, {
        detail: {
          sessionId: id,
          agentId,
          executor,
          ...(hasInstanceUpdate ? { providerInstanceId: nextInstanceId } : {}),
        },
      })
    );
  }
}

export function invalidateWorkspaceSessions(
  queryClient: QueryClient,
  workspaceId: string
) {
  return queryClient.invalidateQueries({
    queryKey: ['workspaceSessions', workspaceId],
  });
}

type SessionListCacheEntry = Pick<Session, 'id'> | Pick<SessionSummary, 'id'>;

export function removeSessionsFromWorkspaceCaches(
  queryClient: QueryClient,
  sessionIds: Iterable<string>
) {
  const deletedSessionIds = new Set(sessionIds);
  if (deletedSessionIds.size === 0) {
    return;
  }

  queryClient.setQueriesData<SessionListCacheEntry[]>(
    { queryKey: ['workspaceSessions'] },
    (current) => {
      if (!Array.isArray(current)) {
        return current;
      }

      return current.filter((session) => !deletedSessionIds.has(session.id));
    }
  );

  queryClient.setQueriesData<WorkspaceWithSession>(
    { queryKey: ['taskAttemptWithSession'] },
    (current) => {
      if (!current?.session || !deletedSessionIds.has(current.session.id)) {
        return current;
      }

      return {
        ...current,
        session: undefined,
      };
    }
  );

  deletedSessionIds.forEach((sessionId) => {
    queryClient.removeQueries({
      queryKey: ['session', sessionId],
    });
  });
}
