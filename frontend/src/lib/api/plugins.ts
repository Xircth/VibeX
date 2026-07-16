import { tauriInvoke } from '@/lib/tauriApi';
import type { Plugin, PluginActivation, PluginInput } from 'shared/types';

export const pluginApi = {
  list: (): Promise<Plugin[]> => tauriInvoke('plugin_list'),

  create: (input: PluginInput): Promise<Plugin> =>
    tauriInvoke('plugin_create', { input }),

  update: (id: string, input: PluginInput): Promise<Plugin> =>
    tauriInvoke('plugin_update', { id, input }),

  remove: (id: string): Promise<void> => tauriInvoke('plugin_delete', { id }),

  /** Only enabled plugins appear in the workspace sidebar. */
  setEnabled: (id: string, enabled: boolean): Promise<Plugin> =>
    tauriInvoke('plugin_set_enabled', { id, enabled }),

  /** Checks node/npx and runs the skill install command globally; the outcome
   *  lands on the returned plugin's `install_status` / `install_error`. */
  installSkill: (id: string): Promise<Plugin> =>
    tauriInvoke('plugin_install_skill', { id }),

  /** Allocate a port and render the console command/URL templates for the
   *  hook. VibeX starts nothing — the agent owns the console. */
  activate: (id: string): Promise<PluginActivation> =>
    tauriInvoke('plugin_activate', { id }),

  /** TCP reachability check of the agent-started console. */
  probeConsole: (url: string): Promise<boolean> =>
    tauriInvoke('plugin_probe_console', { url }),

  /** Write the plugin development kit into `targetDir`; returns the kit root. */
  downloadDevKit: (targetDir: string): Promise<string> =>
    tauriInvoke('plugin_download_dev_kit', { targetDir }),
};
