import { commandRegistry, defineDimoPlugin } from '@dimoai/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  activatePluginModule,
  deactivatePluginModule,
  isPluginModuleActive,
} from './pluginFederation';

describe('v2 plugin module lifecycle', () => {
  it('activates a v2 plugin module and disposes all registrations on deactivate', async () => {
    const pluginId = 'dimo.test-lifecycle';
    const module = defineDimoPlugin({
      id: pluginId,
      activate(ctx) {
        ctx.ui.registerCommand({
          id: 'dimo.test-lifecycle.ping',
          title: 'Ping',
          handler: () => undefined,
        });
      },
    });

    await activatePluginModule(pluginId, module);
    expect(isPluginModuleActive(pluginId)).toBe(true);
    expect(commandRegistry.has('dimo.test-lifecycle.ping')).toBe(true);

    deactivatePluginModule(pluginId);
    expect(isPluginModuleActive(pluginId)).toBe(false);
    expect(commandRegistry.has('dimo.test-lifecycle.ping')).toBe(false);
  });

  it('rejects modules without an activate export', async () => {
    await expect(
      activatePluginModule('dimo.invalid', { notAPlugin: true })
    ).rejects.toThrow('plugin_activate_export_missing');
  });

  it('allows safe deactivation when plugin was never activated', () => {
    expect(() => deactivatePluginModule('dimo.nonexistent')).not.toThrow();
  });
});
