import {
  Suspense,
  createElement,
  lazy,
  useEffect,
  useMemo,
  useRef,
} from 'react';

const LazyOpenConnectorMarketplace = lazy(() => import('../src/views/view'));

function createOpenConnectorStatusComponent(ctx) {
  return function OpenConnectorStatusSurfaceAdapter(props = {}) {
    const surfaceId =
      typeof props.surfaceId === 'string' && props.surfaceId
        ? props.surfaceId
        : 'runtime-status';
    const slot =
      typeof props.slot === 'string' && props.slot
        ? props.slot
        : 'status.after-mcp';
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
      createElement(LazyOpenConnectorMarketplace, { environment })
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

function triggerConnectorMarketplaceModal(ctx, extra = {}) {
  ctx.events?.emit?.('open-connector:open-marketplace', extra);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent('vibex:open-connector-marketplace', {
        detail: {
          pluginId: ctx.pluginId,
          slot: 'status.after-mcp',
          ...extra,
        },
      })
    );
  }
}

export default {
  apiVersion: '2.0',
  id: 'vibex.open-connector',
  activate(ctx) {
    const StatusMarketplaceComponent = createOpenConnectorStatusComponent(ctx);
    const ConfigComponent = createOpenConnectorConfigComponent(ctx);

    ctx.ui.registerView({
      id: 'settings',
      title: 'Open Connector',
      slot: 'plugin.detail.panel',
      component: ConfigComponent,
    });

    ctx.ui.registerStatusBarItem({
      id: 'runtime-status',
      label: '连接器市场',
      tooltip: '打开连接器市场 (1700+ 应用与 MCP)',
      icon: 'plug',
      slot: 'status.after-mcp',
      onActivate: async () => {
        triggerConnectorMarketplaceModal(ctx, { trigger: 'status-bar' });
        try {
          return await ctx.worker.invoke('runtime.statusText', {});
        } catch {
          return { text: '连接器市场' };
        }
      },
    });

    ctx.ui.registerView({
      id: 'runtime-status',
      title: '连接器市场',
      slot: 'status.after-mcp',
      component: StatusMarketplaceComponent,
    });

    ctx.ui.registerCommand({
      id: 'runtime-status-command',
      title: 'Open Connector 状态',
      category: 'Open Connector',
      icon: 'plug',
      handler: async () => {
        triggerConnectorMarketplaceModal(ctx, { trigger: 'command' });
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
      openMarketplace(options = {}) {
        triggerConnectorMarketplaceModal(ctx, options);
      },
      async getStatus() {
        return await ctx.worker.invoke('runtime.status', {});
      },
      async getHealth() {
        return await ctx.worker.invoke('runtime.health', {});
      },
    });
  },
};
