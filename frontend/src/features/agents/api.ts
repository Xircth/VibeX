import { tauriInvoke } from '@/lib/tauriApi';
import type {
  AgentPreparedSessionSnapshot,
  AgentSessionControlsSnapshot,
  AgentSessionListPage,
} from 'shared/types';
import type {
  AgentAvailableCommand,
  AgentConnectionSnapshot,
  AgentPermissionResponse,
  AgentPromptSnapshot,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentTerminalOutputSnapshot,
} from './types';

export type AgentConnectRequest = {
  agentId: string;
  workspaceId: string;
  workingDir: string;
};

export type AgentNewSessionRequest = {
  connectionId: string;
  acpSessionId?: string | null;
};

export type AgentPrepareSessionRequest = {
  agentId: string;
  workspaceId: string;
  sessionId: string;
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

export type AgentResumeSessionRequest = {
  agentId: string;
  workspaceId: string;
  workingDir: string;
  sessionId: string;
  externalSessionId: string;
};

export type AgentTerminalSnapshotRequest = {
  terminalId: string;
};

export type AgentSessionDefaultsView = {
  values: Record<string, unknown>;
  staleIds: string[];
};

export const agentsApi = {
  /** Matching persisted capability catalog; this is a side-effect-free read. */
  capabilityCatalog: (
    agentId: string
  ): Promise<AgentSessionControlsSnapshot | null> =>
    tauriInvoke('agent_capability_catalog', { agentId }),

  capabilityCatalogFresh: (agentId: string): Promise<boolean> =>
    tauriInvoke('agent_capability_catalog_fresh', { agentId }),

  refreshCapabilityCatalog: (agentId: string): Promise<boolean> =>
    tauriInvoke('agent_refresh_capability_catalog', { agentId }),

  sessionDefaults: (agentId: string): Promise<AgentSessionDefaultsView> =>
    tauriInvoke('agent_session_defaults', { agentId }),

  setSessionDefaults: (
    agentId: string,
    defaults: Record<string, unknown>
  ): Promise<void> =>
    tauriInvoke('agent_set_session_defaults', {
      request: { agentId, defaults },
    }),

  snapshot: (): Promise<AgentRuntimeSnapshot> =>
    tauriInvoke('agent_runtime_snapshot'),

  listRemoteSessions: (
    agentId: string,
    workspaceId: string,
    cursor?: string | null
  ): Promise<AgentSessionListPage> =>
    tauriInvoke('agent_list_remote_sessions', {
      request: { agentId, workspaceId, cursor: cursor ?? null },
    }),

  deleteRemoteSession: (
    agentId: string,
    workspaceId: string,
    acpSessionId: string
  ): Promise<void> =>
    tauriInvoke('agent_delete_remote_session', {
      request: { agentId, workspaceId, acpSessionId },
    }),

  importRemoteSession: (
    agentId: string,
    workspaceId: string,
    acpSessionId: string,
    title?: string | null
  ): Promise<{ id: string }> =>
    tauriInvoke('agent_import_remote_session', {
      request: {
        agentId,
        workspaceId,
        acpSessionId,
        title: title ?? null,
      },
    }),

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

  connect: (request: AgentConnectRequest): Promise<AgentConnectionSnapshot> =>
    tauriInvoke('agent_connect', { request }),

  prepareSession: (
    request: AgentPrepareSessionRequest
  ): Promise<AgentPreparedSessionSnapshot> =>
    tauriInvoke('agent_prepare_session', { request }),

  setPreparedSessionMode: (
    sessionId: string,
    modeId: string
  ): Promise<AgentSessionControlsSnapshot> =>
    tauriInvoke('agent_set_prepared_session_mode', {
      request: { sessionId, modeId },
    }),

  setPreparedSessionConfig: (
    sessionId: string,
    key: string,
    value: unknown
  ): Promise<AgentSessionControlsSnapshot> =>
    tauriInvoke('agent_set_prepared_session_config', {
      request: { sessionId, key, value },
    }),

  discardPreparedSession: (sessionId: string): Promise<void> =>
    tauriInvoke('agent_discard_prepared_session', {
      request: { sessionId },
    }),

  newSession: (
    request: AgentNewSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    tauriInvoke('agent_new_session', { request }),

  resumeSession: (
    request: AgentResumeSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    tauriInvoke('agent_resume_session', { request }),

  sendPrompt: (request: AgentSendPromptRequest): Promise<AgentPromptSnapshot> =>
    tauriInvoke('agent_send_prompt', { request }),

  cancelPrompt: (request: AgentCancelPromptRequest): Promise<void> =>
    tauriInvoke('agent_cancel_prompt', { request }),

  disconnect: (
    request: AgentConnectionRequest
  ): Promise<AgentConnectionSnapshot> =>
    tauriInvoke('agent_disconnect', { request }),

  respondPermission: (request: AgentRespondPermissionRequest): Promise<void> =>
    tauriInvoke('agent_respond_permission', { request }),

  terminalSnapshot: (
    request: AgentTerminalSnapshotRequest
  ): Promise<AgentTerminalOutputSnapshot | null> =>
    tauriInvoke('agent_terminal_snapshot', { request }),

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
