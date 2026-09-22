import { definePluginApp } from '@vibex/plugin-sdk/app';

export default definePluginApp(async ({ bridge, root, signal }) => {
  root.innerHTML = '';
  bridge.ready();
  signal.addEventListener(
    'abort',
    () => {
      root.innerHTML = '';
    },
    { once: true },
  );
});
