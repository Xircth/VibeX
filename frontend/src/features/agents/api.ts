import { tauriInvoke } from '@/lib/tauriApi';
import type {
  AgentConnectionSnapshot,
  AgentPromptSnapshot,
  AgentRegistryEntry,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentType,
} from './types';

export type AgentConnectRequest = {
  agentType: AgentType;
  workspaceId: string;
  workingDir: string;
};

export type AgentNewSessionRequest = {
  connectionId: string;
  acpSessionId?: string | null;
};

export type AgentSendPromptRequest = {
  connectionId: string;
  sessionId: string;
  text: string;
};

export type AgentCancelPromptRequest = {
  connectionId: string;
  sessionId: string;
  promptId: string;
};

export const agentsApi = {
  listRegistry: (): Promise<AgentRegistryEntry[]> =>
    tauriInvoke('agent_registry_list'),

  snapshot: (): Promise<AgentRuntimeSnapshot> =>
    tauriInvoke('agent_runtime_snapshot'),

  connect: (request: AgentConnectRequest): Promise<AgentConnectionSnapshot> =>
    tauriInvoke('agent_connect', { request }),

  newSession: (
    request: AgentNewSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    tauriInvoke('agent_new_session', { request }),

  sendPrompt: (
    request: AgentSendPromptRequest
  ): Promise<AgentPromptSnapshot> =>
    tauriInvoke('agent_send_prompt', { request }),

  cancelPrompt: (request: AgentCancelPromptRequest): Promise<void> =>
    tauriInvoke('agent_cancel_prompt', { request }),
};
