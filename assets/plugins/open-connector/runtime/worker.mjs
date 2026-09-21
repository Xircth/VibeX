import { definePluginWorker } from '@vibex/plugin-sdk';

import { createSidecar } from './sidecar.mjs';

export default definePluginWorker((plugin, environment) => {
  const sidecar = createSidecar(environment);
  plugin.handle('surface.createSession', () => sidecar.status());
  plugin.handle('runtime.status', () => sidecar.status());
  plugin.handle('runtime.statusText', () => sidecar.statusText());
  plugin.handle('runtime.health', () => sidecar.health());
  plugin.handle('runtime.restart', () => sidecar.restart());
  plugin.handle('runtime.wipeData', () => sidecar.wipeData());
  plugin.handle('mcp.endpoint', () => sidecar.endpoint());
  plugin.onDispose(() => sidecar.dispose());
  void sidecar.start();
});
