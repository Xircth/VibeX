import { tauriInvoke } from '@/lib/tauriApi';
import type {
  ProviderCapabilityState,
  ProviderCommand,
  ProviderId,
  ProviderModel,
  ProviderRuntimeEvent,
  ProviderRuntimeStatus,
  ProviderSessionSummary,
  ProviderTurnRequest,
  ProviderHistorySnapshot,
} from 'shared/types';

export const providerRuntimeApi = {
  getCapabilities: async (
    provider: ProviderId
  ): Promise<ProviderCapabilityState> =>
    tauriInvoke<ProviderCapabilityState>('provider_runtime_get_capabilities', {
      provider,
    }),

  getStatus: async (provider: ProviderId): Promise<ProviderRuntimeStatus> =>
    tauriInvoke<ProviderRuntimeStatus>('provider_runtime_get_status', {
      provider,
    }),

  getCommands: async (params: {
    provider: ProviderId;
    workspaceId?: string | null;
    repoId?: string | null;
  }): Promise<ProviderCommand[]> =>
    tauriInvoke<ProviderCommand[]>('provider_runtime_get_commands', {
      provider: params.provider,
      workspaceId: params.workspaceId ?? null,
      repoId: params.repoId ?? null,
    }),

  listModels: async (provider: ProviderId): Promise<ProviderModel[]> =>
    tauriInvoke<ProviderModel[]>('provider_runtime_list_models', {
      provider,
    }),

  sendTurn: async (
    request: ProviderTurnRequest
  ): Promise<ProviderRuntimeEvent> =>
    tauriInvoke<ProviderRuntimeEvent>('provider_runtime_send_turn', {
      request,
    }),

  interrupt: async (params: {
    provider: ProviderId;
    threadId?: string | null;
    turnId?: string | null;
  }): Promise<void> =>
    tauriInvoke<void>('provider_runtime_interrupt', {
      provider: params.provider,
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? null,
    }),

  listSessions: async (params: {
    provider: ProviderId;
    workspaceId?: string | null;
  }): Promise<ProviderSessionSummary[]> =>
    tauriInvoke<ProviderSessionSummary[]>('provider_runtime_list_sessions', {
      provider: params.provider,
      workspaceId: params.workspaceId ?? null,
    }),

  loadHistory: async (params: {
    provider: ProviderId;
    sessionId: string;
  }): Promise<ProviderHistorySnapshot> =>
    tauriInvoke<ProviderHistorySnapshot>('provider_runtime_load_history', {
      provider: params.provider,
      sessionId: params.sessionId,
    }),

  respondToRequest: async (params: {
    provider: ProviderId;
    requestId: string;
    response: unknown;
  }): Promise<void> =>
    tauriInvoke<void>('provider_runtime_respond_to_request', {
      provider: params.provider,
      requestId: params.requestId,
      response: params.response,
    }),
};
