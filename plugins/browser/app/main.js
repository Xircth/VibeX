import { Suspense, createElement, lazy, useMemo } from 'react';

const LazyBrowserSettingsSurface = lazy(() => import('../src/views/view'));

function createBrowserSurfaceComponent(ctx, defaultSurfaceId, defaultSlot) {
  return function BrowserSurfaceAdapter(props = {}) {
    const surfaceId =
      typeof props.surfaceId === 'string' && props.surfaceId
        ? props.surfaceId
        : defaultSurfaceId;
    const slot =
      typeof props.slot === 'string' && props.slot ? props.slot : defaultSlot;
    const workspaceId =
      typeof props.workspaceId === 'string' ? props.workspaceId : null;
    const projectId =
      typeof props.projectId === 'string' ? props.projectId : null;
    const environment = useMemo(
      () => ({
        pluginId: ctx.pluginId,
        surfaceId,
        slot,
        workspaceId,
        projectId,
        windowLabel: null,
        invoke: (handler, input) => ctx.worker.invoke(handler, input ?? {}),
      }),
      [projectId, slot, surfaceId, workspaceId]
    );
    return createElement(
      Suspense,
      { fallback: null },
      createElement(LazyBrowserSettingsSurface, { environment })
    );
  };
}

export default {
  apiVersion: '2.0',
  id: 'vibex.browser',
  activate(ctx) {
    const BrowserSettingsComponent = createBrowserSurfaceComponent(
      ctx,
      'browser-settings',
      'app.settings.page'
    );
    const BrowserPanelComponent = createBrowserSurfaceComponent(
      ctx,
      'browser',
      'app.panel'
    );

    ctx.ui.registerSettingsPage({
      id: 'browser-settings',
      title: '浏览器',
      icon: 'globe',
      component: BrowserSettingsComponent,
    });

    ctx.ui.registerView({
      id: 'settings',
      title: '浏览器设置',
      slot: 'plugin.detail.panel',
      component: BrowserSettingsComponent,
    });

    ctx.ui.registerPanel({
      id: 'browser',
      title: 'Browser',
      icon: 'globe',
      zone: 'editor',
      multiInstance: true,
      component: BrowserPanelComponent,
    });

    ctx.ui.registerRailSection({
      id: 'open',
      label: 'Browser',
      tooltip: 'Browser',
      icon: 'globe',
      metadata: {
        opens: {
          kind: 'app.panel',
          id: 'browser',
          instance: 'focus',
        },
      },
      onActivate: () => {
        ctx.events.emit('browser:open-tab', { url: 'about:blank' });
      },
    });

    ctx.ui.registerSlashCommand({
      name: 'browse',
      description:
        'Open URL or inspect active browser tab in the current session',
      prompt:
        'Open and inspect the target URL using the built-in browser tools:',
    });

    ctx.ui.registerCommand({
      id: 'vibex.browser.open-tab',
      title: 'Open Built-in Browser Tab',
      category: 'Browser',
      icon: 'globe',
      handler: () => {
        ctx.events.emit('browser:open-tab', { url: 'about:blank' });
      },
    });

    ctx.services.provide('vibex.browser', {
      openUrl(url) {
        const targetUrl = String(url || 'about:blank').trim() || 'about:blank';
        ctx.events.emit('browser:open-tab', { url: targetUrl });
        return { opened: true, url: targetUrl };
      },
      async dispatch(action, payload = {}) {
        return await ctx.worker.invoke('surface.createSession', {
          action,
          ...payload,
        });
      },
    });
  },
};
