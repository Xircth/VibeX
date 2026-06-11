import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import type { Session, BaseCodingAgent } from 'shared/types';
import { sendAgentRuntimeTurn } from '@/features/agents/sendAgentRuntimeTurn';

interface CreateSessionParams {
  workspaceId: string;
  prompt: string;
  variant: string | null;
  executor: BaseCodingAgent;
}

/**
 * Hook for creating a new session and sending the first message.
 * Uses TanStack Query mutation for proper cache management.
 */
export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      prompt,
      variant,
      executor,
    }: CreateSessionParams): Promise<Session> => {
      const session = await sessionsApi.create({
        workspace_id: workspaceId,
        executor,
        initial_prompt: prompt,
      });

      await sendAgentRuntimeTurn({
        workspaceId,
        sessionId: session.id,
        executorProfileId: { executor, variant },
        text: prompt,
      });

      return session;
    },
    onSuccess: (session) => {
      // Invalidate session queries to refresh the list
      queryClient.invalidateQueries({
        queryKey: ['workspaceSessions', session.workspace_id],
      });
    },
  });
}
