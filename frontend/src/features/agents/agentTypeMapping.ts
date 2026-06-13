import { BaseCodingAgent } from 'shared/types';
import type { AgentType } from './types';

/**
 * Reverse of `agentTypeFromExecutor`: maps an ACP runtime `AgentType` to the
 * `BaseCodingAgent` the executor-profile session flow uses as its identity.
 *
 * `BaseCodingAgent` now covers every ACP agent, so this mapping is total.
 */
const AGENT_TYPE_TO_BASE: Record<AgentType, BaseCodingAgent> = {
  claude_code: BaseCodingAgent.CLAUDE_CODE,
  codex: BaseCodingAgent.CODEX,
  open_code: BaseCodingAgent.OPENCODE,
  gemini: BaseCodingAgent.GEMINI,
  open_claw: BaseCodingAgent.OPENCLAW,
  cline: BaseCodingAgent.CLINE,
  hermes: BaseCodingAgent.HERMES,
};

export function baseCodingAgentFromAgentType(
  agentType: AgentType
): BaseCodingAgent | null {
  return AGENT_TYPE_TO_BASE[agentType] ?? null;
}
