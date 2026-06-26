import { BaseCodingAgent, type ExecutorProfileId } from 'shared/types';
import { conversationApi } from '@/features/conversation/conversationApi';
import type {
  AgentSessionConfigOverride,
  ConversationTurnSnapshot,
} from 'shared/types';
import type { AgentType } from './types';

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

export function agentTypeFromExecutor(executor: BaseCodingAgent): AgentType {
  switch (executor) {
    case BaseCodingAgent.CLAUDE_CODE:
      return 'claude_code';
    case BaseCodingAgent.CODEX:
      return 'codex';
    case BaseCodingAgent.OPENCODE:
      return 'open_code';
    case BaseCodingAgent.GEMINI:
      return 'gemini';
    case BaseCodingAgent.OPENCLAW:
      return 'open_claw';
    case BaseCodingAgent.CLINE:
      return 'cline';
    case BaseCodingAgent.HERMES:
      return 'hermes';
    default:
      throw new Error(`ACP-native agent is not registered for ${executor}`);
  }
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
    agentType: agentTypeFromExecutor(executorProfileId.executor),
    workspaceId,
    conversationId: sessionId,
    executorProfileId,
    text: displayText ?? text,
    images,
    modeOverride: modeOverride ?? null,
    configOverrides: configOverrides ?? [],
  });
}
