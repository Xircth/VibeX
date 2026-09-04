import { definePluginWorker } from '@vibex/plugin-sdk';

import { discoverProviders } from './providers.mjs';

/**
 * Official consumer of `provider.model.importSource`.
 *
 * It only reports what it found; the Host renders the picker and writes the
 * presets, and importing never binds an agent.
 */
export default definePluginWorker((plugin) => {
  plugin.handle('import.environment', () => ({
    providers: discoverProviders(process.env),
  }));
});
