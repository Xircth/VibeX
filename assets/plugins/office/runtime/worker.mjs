import { definePluginWorker } from '@vibex/plugin-sdk';

export default definePluginWorker((plugin, environment) => {
  plugin.handle('office-preview', (input) =>
    environment.host.call('artifact.preview', 'open', input)
  );
});
