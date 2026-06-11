import { BaseCodingAgent, type ExecutorProfileId } from 'shared/types';
import { agentsApi } from './api';
import type { AgentPromptSnapshot, AgentType } from './types';

export type AgentRuntimeTurnInput = {
  workspaceId: string;
  sessionId: string;
  executorProfileId: ExecutorProfileId;
  text: string;
  displayText?: string;
  images?: string[];
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
}: AgentRuntimeTurnInput): Promise<AgentPromptSnapshot> {
  return agentsApi.sendWorkspacePrompt({
    agentType: agentTypeFromExecutor(executorProfileId.executor),
    workspaceId,
    sessionId,
    text: displayText ?? text,
    images,
  });
}
