import type {
  AgentDiagnosticView,
  AgentId,
  AgentManagementView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
  AgentOperationReceipt,
  AgentPreflightView,
  AgentRegistryView,
  AgentUpdateCheckView,
} from 'shared/types';

import { backendCall } from '@/lib/backendTransport';

export const agentManagementApi = {
  bar: (): Promise<AgentManagementView[]> =>
    backendCall('agent_management_bar'),

  refreshBar: (): Promise<AgentManagementView[]> =>
    backendCall('agent_management_refresh'),

  detail: (agentId: AgentId): Promise<AgentManagementView> =>
    backendCall('agent_management_detail', { agentId }),

  registry: (): Promise<AgentRegistryView> =>
    backendCall('agent_registry_view'),

  refreshRegistry: (): Promise<AgentRegistryView> =>
    backendCall('agent_registry_refresh'),

  addAndInstall: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_registry_add_and_install', { agentId }),

  setEnabled: (
    agentId: AgentId,
    enabled: boolean
  ): Promise<AgentManagementView> =>
    backendCall('agent_management_set_enabled', { agentId, enabled }),

  reorder: (agentIds: AgentId[]): Promise<AgentManagementView[]> =>
    backendCall('agent_management_reorder', { agentIds }),

  preflight: (agentId: AgentId): Promise<AgentPreflightView> =>
    backendCall('agent_management_preflight', { agentId }),

  repair: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_repair', { agentId }),

  checkUpdate: (agentId: AgentId): Promise<AgentUpdateCheckView> =>
    backendCall('agent_management_check_update', { agentId }),

  applyUpdate: (agentId: AgentId): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_apply_update', { agentId }),

  rollback: (agentId: AgentId): Promise<AgentManagementView> =>
    backendCall('agent_management_rollback', { agentId }),

  cancelOperation: (
    agentId: AgentId,
    operationId: string
  ): Promise<AgentOperationReceipt> =>
    backendCall('agent_management_cancel_operation', {
      agentId,
      operationId,
    }),

  uninstall: (agentId: AgentId): Promise<AgentManagementView> =>
    backendCall('agent_management_uninstall', { agentId }),

  remove: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_remove', { agentId }),

  readConfig: (agentId: AgentId): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_read', { agentId }),

  writeConfig: (
    request: AgentNativeConfigPatchRequest
  ): Promise<AgentNativeConfigView> =>
    backendCall('agent_management_config_write', { request }),

  diagnostics: (agentId: AgentId): Promise<AgentDiagnosticView[]> =>
    backendCall('agent_management_diagnostics', { agentId }),

  clearDiagnostics: (agentId: AgentId): Promise<void> =>
    backendCall('agent_management_clear_diagnostics', { agentId }),
};
