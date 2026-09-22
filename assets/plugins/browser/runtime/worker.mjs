import { definePluginWorker } from '@vibex/plugin-sdk';

export default definePluginWorker((registrar, environment) => {
  registrar.handle('surface.createSession', () => ({ ready: true }));
  registrar.handle('browser.dispatch', async (input) => {
    const body = input && typeof input === 'object' ? input : {};
    const operation =
      typeof body.operation === 'string' ? body.operation : '';
    const payload =
      body.input && typeof body.input === 'object' ? body.input : {};
    return environment.host.call('browser', operation, payload);
  });
});
