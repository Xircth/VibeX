import { tauriInvoke } from '@/lib/tauriApi';
import type {
  AgentConfigSurface,
  AgentConnectionSnapshot,
  AgentInstallPlan,
  AgentMcpSurface,
  AgentPermissionResponse,
  AgentPromptSnapshot,
  AgentRegistryEntry,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentSkillsSurface,
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

export type AgentSendWorkspacePromptRequest = {
  agentType: AgentType;
  workspaceId: string;
  sessionId: string;
  text: string;
  images?: string[];
};

export type AgentCancelPromptRequest = {
  connectionId: string;
  sessionId: string;
  promptId: string;
};

export type AgentRespondPermissionRequest = {
  connectionId: string;
  permissionId: string;
  response: AgentPermissionResponse;
};

export const agentsApi = {
  listRegistry: (): Promise<AgentRegistryEntry[]> =>
    tauriInvoke('agent_registry_list'),

  listConfigSurfaces: (): Promise<AgentConfigSurface[]> =>
    tauriInvoke('agent_config_surfaces'),

  listMcpSurfaces: (): Promise<AgentMcpSurface[]> =>
    tauriInvoke('agent_mcp_surfaces'),

  listSkillsSurfaces: (): Promise<AgentSkillsSurface[]> =>
    tauriInvoke('agent_skills_surfaces'),

  listInstallPlans: (): Promise<AgentInstallPlan[]> =>
    tauriInvoke('agent_install_plans'),

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

  sendWorkspacePrompt: (
    request: AgentSendWorkspacePromptRequest
  ): Promise<AgentPromptSnapshot> =>
    tauriInvoke('agent_send_workspace_prompt', { request }),

  cancelPrompt: (request: AgentCancelPromptRequest): Promise<void> =>
    tauriInvoke('agent_cancel_prompt', { request }),

  respondPermission: (request: AgentRespondPermissionRequest): Promise<void> =>
    tauriInvoke('agent_respond_permission', { request }),
};
