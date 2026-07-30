import { backendCall } from '@/lib/backendTransport';
import type {
  AgentPreparedSessionSnapshot,
  AgentSessionControlsSnapshot,
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

export const agentsApi = {
  /** Matching persisted capability catalog; this is a side-effect-free read. */
  capabilityCatalog: (
    agentId: string
  ): Promise<AgentSessionControlsSnapshot | null> =>
    backendCall('agent_capability_catalog', { agentId }),

  refreshCapabilityCatalog: (agentId: string): Promise<boolean> =>
    backendCall('agent_refresh_capability_catalog', { agentId }),

  snapshot: (): Promise<AgentRuntimeSnapshot> =>
    backendCall('agent_runtime_snapshot'),

  connectionSnapshot: (
    request: AgentConnectionRequest
  ): Promise<AgentConnectionSnapshot> =>
    backendCall('agent_connection_snapshot', { request }),

  loadSession: (request: AgentSessionRequest): Promise<AgentSessionSnapshot> =>
    backendCall('agent_load_session', { request }),

  listSessionCommands: (
    request: AgentSessionRequest
  ): Promise<AgentAvailableCommand[]> =>
    backendCall('agent_list_session_commands', { request }),

  connect: (request: AgentConnectRequest): Promise<AgentConnectionSnapshot> =>
    backendCall('agent_connect', { request }),

  prepareSession: (
    request: AgentPrepareSessionRequest
  ): Promise<AgentPreparedSessionSnapshot> =>
    backendCall('agent_prepare_session', { request }),

  setPreparedSessionMode: (
    sessionId: string,
    modeId: string
  ): Promise<AgentSessionControlsSnapshot> =>
    backendCall('agent_set_prepared_session_mode', {
      request: { sessionId, modeId },
    }),

  setPreparedSessionConfig: (
    sessionId: string,
    key: string,
    value: unknown
  ): Promise<AgentSessionControlsSnapshot> =>
    backendCall('agent_set_prepared_session_config', {
      request: { sessionId, key, value },
    }),

  discardPreparedSession: (sessionId: string): Promise<void> =>
    backendCall('agent_discard_prepared_session', {
      request: { sessionId },
    }),

  newSession: (
    request: AgentNewSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    backendCall('agent_new_session', { request }),

  resumeSession: (
    request: AgentResumeSessionRequest
  ): Promise<AgentSessionSnapshot> =>
    backendCall('agent_resume_session', { request }),

  sendPrompt: (request: AgentSendPromptRequest): Promise<AgentPromptSnapshot> =>
    backendCall('agent_send_prompt', { request }),

  cancelPrompt: (request: AgentCancelPromptRequest): Promise<void> =>
    backendCall('agent_cancel_prompt', { request }),

  disconnect: (
    request: AgentConnectionRequest
  ): Promise<AgentConnectionSnapshot> =>
    backendCall('agent_disconnect', { request }),

  respondPermission: (request: AgentRespondPermissionRequest): Promise<void> =>
    backendCall('agent_respond_permission', { request }),

  terminalSnapshot: (
    request: AgentTerminalSnapshotRequest
  ): Promise<AgentTerminalOutputSnapshot | null> =>
    backendCall('agent_terminal_snapshot', { request }),

  // Restore the workspace to the checkpoint recorded before the Nth user message
  // (ordinal). Destructive when performGitReset; the ACP transcript is not
  // truncated. Resolves with no checkpoint -> the caller falls back to resend.
  resetToCheckpoint: (
    sessionId: string,
    ordinal: number,
    performGitReset = true,
    forceWhenDirty = false
  ): Promise<void> =>
    backendCall('agent_reset_to_checkpoint', {
      sessionId,
      ordinal,
      performGitReset,
      forceWhenDirty,
    }),
};
