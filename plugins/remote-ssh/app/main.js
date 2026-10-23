import { createElement, useEffect, useRef } from 'react';

function createRemoteSshConnectPanelComponent(ctx) {
  return function RemoteSshConnectPanelSurface() {
    const rootRef = useRef(null);
    useEffect(() => {
      const node = rootRef.current;
      if (!node) return;
      const controller = new AbortController();
      void Promise.all([
        import('../runtime/app.css'),
        import('../runtime/app.mjs'),
      ]).then(([, { mountRemoteSshApp }]) => {
        if (controller.signal.aborted) return;
        return mountRemoteSshApp({
          root: node,
          signal: controller.signal,
          bridge: {
            invoke: (handler, input) => ctx.worker.invoke(handler, input ?? {}),
            ready: () => undefined,
          },
        });
      });
      return () => {
        controller.abort();
        node.replaceChildren();
      };
    }, []);
    return createElement('div', {
      ref: rootRef,
      style: { width: '100%', minHeight: 480 },
    });
  };
}

export default {
  apiVersion: '2.0',
  id: 'vibex.remote-ssh',
  activate(ctx) {
    const ConnectPanelComponent = createRemoteSshConnectPanelComponent(ctx);

    ctx.ui.registerSettingsPage({
      id: 'connect-panel',
      title: 'Remote SSH',
      icon: 'cloud',
      component: ConnectPanelComponent,
    });

    ctx.ui.registerView({
      id: 'connect-panel',
      title: 'Remote SSH',
      slot: 'plugin.detail.panel',
      component: ConnectPanelComponent,
    });

    ctx.ui.registerCommand({
      id: 'vibex.remote-ssh.connect',
      title: 'Connect to Remote SSH Host',
      category: 'Remote SSH',
      icon: 'cloud',
      handler: () => {
        ctx.events.emit('remote-ssh:open-connect-panel');
      },
    });

    ctx.ui.registerSlashCommand({
      name: 'ssh-connect',
      description: 'Diagnose or connect to a remote SSH VibeX Server host',
      prompt:
        'Check SSH connectivity and remote VibeX Server status for host:',
    });

    ctx.services.provide('vibex.remote-ssh', {
      provisionKind: 'ssh',
      async ensureProvisioned(input = {}) {
        return await ctx.worker.invoke('provision.ensure', input);
      },
      async testSession(input = {}) {
        return await ctx.worker.invoke('session.test', input);
      },
    });
  },
};
