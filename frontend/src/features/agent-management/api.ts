import type {
  AgentDiagnosticView,
  AgentId,
  AgentManagementView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
  AgentOperationReceipt,
  AgentPreflightView,
  AgentRegistryView,
} from 'shared/types';

import { tauriInvoke } from '@/lib/tauriApi';

export const agentManagementApi = {
  bar: (): Promise<AgentManagementView[]> =>
    tauriInvoke('agent_management_bar'),

  detail: (agentId: AgentId): Promise<AgentManagementView> =>
    tauriInvoke('agent_management_detail', { agentId }),

  registry: (): Promise<AgentRegistryView> =>
    tauriInvoke('agent_registry_view'),

  refreshRegistry: (): Promise<AgentRegistryView> =>
    tauriInvoke('agent_registry_refresh'),

  addAndInstall: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    tauriInvoke('agent_registry_add_and_install', { agentId }),

  setEnabled: (
    agentId: AgentId,
    enabled: boolean
  ): Promise<AgentManagementView> =>
    tauriInvoke('agent_management_set_enabled', { agentId, enabled }),

  reorder: (agentIds: AgentId[]): Promise<AgentManagementView[]> =>
    tauriInvoke('agent_management_reorder', { agentIds }),

  preflight: (agentId: AgentId): Promise<AgentPreflightView> =>
    tauriInvoke('agent_management_preflight', { agentId }),

  repair: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    tauriInvoke('agent_management_repair', { agentId }),

  update: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    tauriInvoke('agent_management_update', { agentId }),

  rollback: (agentId: AgentId): Promise<AgentManagementView> =>
    tauriInvoke('agent_management_rollback', { agentId }),

  cancelOperation: (
    agentId: AgentId,
    operationId: string
  ): Promise<AgentOperationReceipt> =>
    tauriInvoke('agent_management_cancel_operation', {
      agentId,
      operationId,
    }),

  uninstall: (agentId: AgentId): Promise<AgentManagementView> =>
    tauriInvoke('agent_management_uninstall', { agentId }),

  remove: (agentId: AgentId): Promise<void> =>
    tauriInvoke('agent_management_remove', { agentId }),

  readConfig: (agentId: AgentId): Promise<AgentNativeConfigView> =>
    tauriInvoke('agent_management_config_read', { agentId }),

  writeConfig: (
    request: AgentNativeConfigPatchRequest
  ): Promise<AgentNativeConfigView> =>
    tauriInvoke('agent_management_config_write', { request }),

  diagnostics: (agentId: AgentId): Promise<AgentDiagnosticView[]> =>
    tauriInvoke('agent_management_diagnostics', { agentId }),

  clearDiagnostics: (agentId: AgentId): Promise<void> =>
    tauriInvoke('agent_management_clear_diagnostics', { agentId }),
};
