import React from 'react';
import { createRoot } from 'react-dom/client';
import { definePluginApp } from '@vibex/plugin-sdk/app';
import ComputerUseSettingsView from '../src/views/view.tsx';
import appCss from './app.css?inline';
import { retainStyle } from '../src/styles/retainStyles.ts';

export default definePluginApp(({ root, bridge, slot }) => {
  const releaseStyles = retainStyle('vibex-plugin-computer-use', appCss);
  const reactRoot = createRoot(root);
  reactRoot.render(
    React.createElement(ComputerUseSettingsView, {
      environment: {
        pluginId: bridge.pluginId,
        surfaceId: 'computer-use',
        slot: slot ?? 'app.settings.page',
        invoke: (handler, input) => bridge.invoke(handler, input ?? {}),
      },
    })
  );
  bridge.ready();
  return () => {
    reactRoot.unmount();
    releaseStyles();
  };
});
