import type { AgentId, ExecutorProfileId } from 'shared/types';
import { conversationApi } from '@/features/conversation/conversationApi';
import type {
  AgentSessionConfigOverride,
  ConversationInputSubmission,
  ConversationInputPayload,
} from 'shared/types';
import type { ConversationPluginActionInvocation } from '@/features/conversation/conversationApi';

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
  /** Structured plugin actions selected in the composer for this turn. */
  pluginActions?: ConversationPluginActionInvocation[];
  fileRefs?: ConversationInputPayload['fileRefs'];
  operationId?: string;
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
  pluginActions,
  fileRefs,
  operationId,
}: AgentRuntimeTurnInput): Promise<ConversationInputSubmission> {
  const payload: ConversationInputPayload = {
    agentId: agentTypeFromExecutor(executorProfileId.executor),
    workspaceId,
    executorProfileId:
      executorProfileId as unknown as ConversationInputPayload['executorProfileId'],
    text,
    displayText: displayText ?? text,
    images,
    modeOverride: modeOverride ?? null,
    configOverrides: configOverrides ?? [],
    pluginActions: pluginActions ?? [],
    fileRefs: fileRefs ?? [],
  };
  return conversationApi.submitInput(sessionId, payload, operationId);
}
