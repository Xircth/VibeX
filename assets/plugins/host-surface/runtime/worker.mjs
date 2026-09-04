import { definePluginWorker } from '@vibex/plugin-sdk';

export default definePluginWorker((plugin) => {
  plugin.handle('surface.createSession', () => ({ ready: true }));
  plugin.handle('hello', () => ({ message: 'Host surface sample' }));
});
