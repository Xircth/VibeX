import { tauriInvoke } from '@/lib/tauriApi';
import type { DbConversationDetail, DbConversationSummary } from 'shared/types';
import type {
  AgentAvailableCommand,
  AgentConfigSurface,
  AgentConnectionSnapshot,
  AgentHistorySource,
  AgentInstallPlan,
  AgentMcpSurface,
  AgentPermissionResponse,
  AgentPromptSnapshot,
  AgentRegistryEntry,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentSkillsSurface,
  AgentTerminalOutputSnapshot,
  AgentType,
  ImportedAgentSession,
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

export type AgentRespondPermissionRequest = {
  connectionId: string;
  permissionId: string;
  response: AgentPermissionResponse;
};

export type AgentConnectionRequest = {
  connectionId: string;
};

export type AgentSessionRequest = {
  sessionId: string;
};

export type AgentSetAutoApproveRequest = {
  agentType: AgentType;
  autoApproveMode: 'off' | 'allow_always' | 'yolo';
};

export type AgentResumeSessionRequest = {
  agentType: AgentType;
  workspaceId: string;
  workingDir: string;
  sessionId: string;
  externalSessionId: string;
};

export type AgentTerminalSnapshotRequest = {
  terminalId: string;
};

export type AgentTypeRequest = {
  agentType: AgentType;
};

export type AgentHistoryImportRequest = {
  agentType: AgentType;
  path?: string | null;
  workspaceId?: string | null;
};

export type AgentConfigFile = {
  path: string;
  content: string;
};

export type AgentMcpConfigFile = {
  path: string;
  config: unknown;
  surface: unknown;
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

  connectionSnapshot: (
    request: AgentConnectionRequest
  ): Promise<AgentConnectionSnapshot> =>
    tauriInvoke('agent_connection_snapshot', { request }),

  loadSession: (request: AgentSessionRequest): Promise<AgentSessionSnapshot> =>
    tauriInvoke('agent_load_session', { request }),

  listSessionCommands: (
    request: AgentSessionRequest
  ): Promise<AgentAvailableCommand[]> =>
    tauriInvoke('agent_list_session_commands', { request }),

  setAutoApprove: (request: AgentSetAutoApproveRequest): Promise<void> =>
    tauriInvoke('agent_set_auto_approve', { request }),

  connect: (request: AgentConnectRequest): Promise<AgentConnectionSnapshot> =>
    tauriInvoke('agent_connect', { request }),

  newSession: (
    request: AgentNewSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    tauriInvoke('agent_new_session', { request }),

  resumeSession: (
    request: AgentResumeSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    tauriInvoke('agent_resume_session', { request }),

  sendPrompt: (
    request: AgentSendPromptRequest
  ): Promise<AgentPromptSnapshot> =>
    tauriInvoke('agent_send_prompt', { request }),

  cancelPrompt: (request: AgentCancelPromptRequest): Promise<void> =>
    tauriInvoke('agent_cancel_prompt', { request }),

  disconnect: (request: AgentConnectionRequest): Promise<AgentConnectionSnapshot> =>
    tauriInvoke('agent_disconnect', { request }),

  respondPermission: (request: AgentRespondPermissionRequest): Promise<void> =>
    tauriInvoke('agent_respond_permission', { request }),

  terminalSnapshot: (
    request: AgentTerminalSnapshotRequest
  ): Promise<AgentTerminalOutputSnapshot | null> =>
    tauriInvoke('agent_terminal_snapshot', { request }),

  historySources: (request: AgentTypeRequest): Promise<AgentHistorySource[]> =>
    tauriInvoke('agent_history_sources', { request }),

  importHistory: (
    request: AgentHistoryImportRequest
  ): Promise<ImportedAgentSession[]> =>
    tauriInvoke('agent_history_import', { request }),

  readConfig: (request: AgentTypeRequest): Promise<AgentConfigFile | null> =>
    tauriInvoke('agent_config_read', { request }),

  writeConfig: (request: AgentTypeRequest & { content: string }): Promise<void> =>
    tauriInvoke('agent_config_write', { request }),

  readMcp: (request: AgentTypeRequest): Promise<AgentMcpConfigFile | null> =>
    tauriInvoke('agent_mcp_list', { request }),

  writeMcp: (request: AgentTypeRequest & { config: unknown }): Promise<void> =>
    tauriInvoke('agent_mcp_write', { request }),

  // Conversation metadata + projected timeline from the durable VibeX event log.
  // `sessionId` is the local VibeX conversation row id.
  conversationDetail: (sessionId: string): Promise<DbConversationDetail | null> =>
    tauriInvoke('conversation_detail', { sessionId }),

  conversationList: (workspaceId: string): Promise<DbConversationSummary[]> =>
    tauriInvoke('conversation_list', { workspaceId }),

  // Restore the workspace to the checkpoint recorded before the Nth user message
  // (ordinal). Destructive when performGitReset; the ACP transcript is not
  // truncated. Resolves with no checkpoint -> the caller falls back to resend.
  resetToCheckpoint: (
    sessionId: string,
    ordinal: number,
    performGitReset = true,
    forceWhenDirty = false
  ): Promise<void> =>
    tauriInvoke('agent_reset_to_checkpoint', {
      sessionId,
      ordinal,
      performGitReset,
      forceWhenDirty,
    }),
};
