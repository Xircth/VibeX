import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import type {
  OfficeComponentReadiness,
  OfficePluginCatalog,
} from 'shared/types';

export type PluginComponentStatus = OfficeComponentReadiness['status'];
export type PluginActionCatalog = OfficePluginCatalog;

export function createPluginApi(transport: BackendTransport) {
  return {
    catalog: () =>
      transport.call('plugin_action_catalog') as Promise<PluginActionCatalog>,
    installOffice: (taskId: string) =>
      transport.call('officecli_install', { taskId }),
    cancelOfficeInstall: (taskId: string) =>
      transport.call('officecli_cancel_install', { taskId }),
    setOfficeEnabled: (enabled: boolean, taskId: string) =>
      transport.call('office_plugin_set_enabled', { enabled, taskId }),
  };
}

export const pluginV2Api = createPluginApi(configuredBackendTransport);
