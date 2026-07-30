import type { AgentId, ExecutorProfileId } from 'shared/types';
import { conversationApi } from '@/features/conversation/conversationApi';
import type {
  AgentSessionConfigOverride,
  ConversationTurnSnapshot,
} from 'shared/types';

export type AgentRuntimeTurnInput = {
  workspaceId: string;
  sessionId: string;
  executorProfileId: ExecutorProfileId;
  text: string;
  displayText?: string;
  images?: string[];
  /** Composer-selected session mode for this turn (agent-advertised). */
  modeOverride?: string | null;
  /** Composer-selected session config overrides for this turn. */
  configOverrides?: AgentSessionConfigOverride[];
};

/**
 * Resolve the ACP runtime `AgentType` for an executor identity. After batch D2
 * the executor identity and the ACP `AgentKind` are the same union, so this is
 * an identity mapping retained for call-site clarity.
 */
export function agentTypeFromExecutor(executor: AgentId): AgentId {
  return executor;
}

export async function sendAgentRuntimeTurn({
  workspaceId,
  sessionId,
  executorProfileId,
  text,
  displayText,
  images,
  modeOverride,
  configOverrides,
}: AgentRuntimeTurnInput): Promise<ConversationTurnSnapshot> {
  return conversationApi.startTurn({
    agentId: agentTypeFromExecutor(executorProfileId.executor),
    workspaceId,
    conversationId: sessionId,
    executorProfileId,
    text: displayText ?? text,
    images,
    modeOverride: modeOverride ?? null,
    configOverrides: configOverrides ?? [],
  });
}
