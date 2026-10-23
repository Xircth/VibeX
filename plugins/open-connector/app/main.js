import {
  Suspense,
  createElement,
  lazy,
  useEffect,
  useMemo,
  useRef,
} from 'react';

const LazyOpenConnectorConsole = lazy(() => import('../src/views/view'));

function createOpenConnectorConsoleComponent(ctx) {
  return function OpenConnectorConsoleAdapter(props = {}) {
    const surfaceId =
      typeof props.surfaceId === 'string' && props.surfaceId
        ? props.surfaceId
        : 'console';
    const slot =
      typeof props.slot === 'string' && props.slot ? props.slot : 'app.tab';
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
      createElement(LazyOpenConnectorConsole, { environment })
    );
  };
}

function createOpenConnectorConfigComponent(ctx) {
  return function OpenConnectorConfigSurface() {
    const rootRef = useRef(null);
    useEffect(() => {
      const node = rootRef.current;
      if (!node) return;
      let dispose;
      let cancelled = false;
      void Promise.all([
        import('../runtime/app.css'),
        import('../runtime/config-panel.mjs'),
      ])
        .then(([, { mountConfigPanel }]) => {
          if (cancelled) return undefined;
          return mountConfigPanel(node, (handler, input) =>
            ctx.worker.invoke(handler, input ?? {})
          );
        })
        .then((cleanup) => {
          if (cancelled) cleanup?.();
          else dispose = cleanup;
        });
      return () => {
        cancelled = true;
        dispose?.();
      };
    }, []);
    return createElement('div', {
      ref: rootRef,
      style: { width: '100%', minHeight: 240 },
    });
  };
}

export default {
  apiVersion: '2.0',
  id: 'vibex.open-connector',
  activate(ctx) {
    const ConsoleComponent = createOpenConnectorConsoleComponent(ctx);
    const ConfigComponent = createOpenConnectorConfigComponent(ctx);

    ctx.ui.registerTab({
      id: 'console',
      title: 'Open Connector',
      icon: 'plug',
      component: ConsoleComponent,
    });

    ctx.ui.registerSettingsPage({
      id: 'settings',
      title: 'Open Connector',
      icon: 'plug',
      component: ConfigComponent,
    });

    ctx.ui.registerView({
      id: 'settings',
      title: 'Open Connector',
      slot: 'plugin.detail.panel',
      component: ConfigComponent,
    });

    ctx.ui.registerStatusBarItem({
      id: 'runtime-status',
      label: 'Open Connector',
      icon: 'plug',
      slot: 'status.main',
      onActivate: async () => {
        try {
          await ctx.worker.invoke('runtime.statusText', {});
        } catch {
          // Ignore when connector runtime is not running locally.
        }
      },
    });

    ctx.ui.registerCommand({
      id: 'runtime-status-command',
      title: 'Open Connector 状态',
      category: 'Open Connector',
      icon: 'plug',
      handler: async () => {
        try {
          return await ctx.worker.invoke('runtime.statusText', {});
        } catch {
          return { text: 'Open Connector: offline' };
        }
      },
    });

    ctx.ui.registerSlashCommand({
      name: 'connector',
      description: 'List or invoke connected third-party SaaS integrations',
      prompt: 'Inspect available Open Connector integrations for this task:',
    });

    ctx.services.provide('vibex.open-connector', {
      gatewayVersion: '2.0.0',
      async getStatus() {
        return await ctx.worker.invoke('runtime.status', {});
      },
      async getHealth() {
        return await ctx.worker.invoke('runtime.health', {});
      },
    });
  },
};
