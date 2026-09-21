import { definePluginApp } from '@vibex/plugin-sdk/app';

import { mountConfigPanel } from './config-panel.mjs';
import { mountConsoleEmbed } from './console-embed.mjs';
import './app.css';

export default definePluginApp(async ({ root, bridge, slot }) => {
  const invoke = (handler, input) => bridge.invoke(handler, input ?? null);
  const dispose =
    slot === 'plugin.detail.panel'
      ? await mountConfigPanel(root, invoke)
      : await mountConsoleEmbed(root, invoke);
  bridge.ready();
  return () => {
    if (typeof dispose === 'function') void dispose();
  };
});
