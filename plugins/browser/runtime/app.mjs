import React from 'react';
import { createRoot } from 'react-dom/client';
import { definePluginApp } from '@vibex/plugin-sdk/app';
import BrowserSettingsRemoteView from '../src/views/view.tsx';
import './app.css';

function PluginConfigNote() {
  return React.createElement(
    'div',
    {
      className: 'browser-plugin-config-empty',
      'data-testid': 'plugin-browser-config-empty',
    },
    React.createElement(
      'p',
      null,
      '浏览器设置请在「设置 → 浏览器」中修改。'
    )
  );
}

export default definePluginApp(({ root, bridge, slot }) => {
  const reactRoot = createRoot(root);
  reactRoot.render(
    slot === 'plugin.detail.panel'
      ? React.createElement(PluginConfigNote)
      : React.createElement(BrowserSettingsRemoteView, {
          environment: {
            pluginId: bridge.pluginId,
            surfaceId: 'browser-settings',
            slot: slot ?? 'app.settings.page',
            invoke: (handler, input) => bridge.invoke(handler, input ?? {}),
          },
        })
  );
  bridge.ready();
  return () => {
    reactRoot.unmount();
  };
});
