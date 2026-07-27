import type { QueryClient } from '@tanstack/react-query';
import type { AgentSessionControlsSnapshot } from 'shared/types';
import type { AgentType } from './types';

export function sessionControlsQueryKey(
  agentType: AgentType,
  workspaceId: string | null
) {
  return ['agent-session-controls-catalog', agentType, workspaceId] as const;
}

/**
 * Share the exact controls already rendered by a workspace's composer with
 * its create-session form. Workspace scoping prevents provider/account state
 * from one live ACP session becoming another workspace's assumed defaults.
 */
export function publishLiveSessionControls(
  queryClient: QueryClient,
  {
    agentType,
    workspaceId,
    controls,
  }: {
    agentType: AgentType;
    workspaceId: string;
    controls: AgentSessionControlsSnapshot;
  }
): void {
  queryClient.setQueryData(
    sessionControlsQueryKey(agentType, workspaceId),
    controls
  );
}
