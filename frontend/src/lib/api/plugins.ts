import { backendCall } from '@/lib/backendTransport';
import {
  tauriBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import type {
  OfficeComponentReadiness,
  OfficePluginCatalog,
  Plugin,
  PluginActivation,
  PluginInput,
} from 'shared/types';

export type PluginComponentStatus = OfficeComponentReadiness['status'];
export type PluginActionCatalog = OfficePluginCatalog;

export interface LegacyPluginMigrationSummary {
  legacyPluginId: string;
  name: string;
  status: 'migration_required' | 'mapped_builtin';
  mappedPluginId: string | null;
}

export function createPluginApi(transport: BackendTransport) {
  return {
    catalog: () =>
      transport.call('plugin_action_catalog') as Promise<PluginActionCatalog>,
    listLegacy: () =>
      transport.call('plugin_legacy_migration_list') as Promise<
        LegacyPluginMigrationSummary[]
      >,
    installOffice: (taskId: string) =>
      transport.call('officecli_install', { taskId }),
    cancelOfficeInstall: (taskId: string) =>
      transport.call('officecli_cancel_install', { taskId }),
    setOfficeEnabled: (enabled: boolean, taskId: string) =>
      transport.call('office_plugin_set_enabled', { enabled, taskId }),
  };
}

export const pluginV2Api = createPluginApi(tauriBackendTransport);

export const pluginApi = {
  list: (): Promise<Plugin[]> => backendCall('plugin_list'),

  create: (input: PluginInput): Promise<Plugin> =>
    backendCall('plugin_create', { input }),

  update: (id: string, input: PluginInput): Promise<Plugin> =>
    backendCall('plugin_update', { id, input }),

  remove: (id: string): Promise<void> => backendCall('plugin_delete', { id }),

  /** Only enabled plugins appear in the workspace sidebar. */
  setEnabled: (id: string, enabled: boolean): Promise<Plugin> =>
    backendCall('plugin_set_enabled', { id, enabled }),

  /** Checks node/npx and runs the skill install command globally; the outcome
   *  lands on the returned plugin's `install_status` / `install_error`. */
  installSkill: (id: string): Promise<Plugin> =>
    backendCall('plugin_install_skill', { id }),

  /** Allocate a port and render the console command/URL templates for the
   *  hook. VibeX starts nothing — the agent owns the console. */
  activate: (id: string): Promise<PluginActivation> =>
    backendCall('plugin_activate', { id }),

  /** TCP reachability check of the agent-started console. */
  probeConsole: (url: string): Promise<boolean> =>
    backendCall('plugin_probe_console', { url }),

  /** Write the plugin development kit into `targetDir`; returns the kit root. */
  downloadDevKit: (targetDir: string): Promise<string> =>
    backendCall('plugin_download_dev_kit', { targetDir }),
};
