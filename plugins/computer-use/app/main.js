import { Suspense, createElement, lazy, useMemo } from 'react';

const LazyComputerUseSurface = lazy(() => import('../src/views/view'));

function createComputerUseSurfaceComponent(ctx, defaultSurfaceId, defaultSlot) {
  return function ComputerUseSurfaceAdapter(props = {}) {
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
      createElement(LazyComputerUseSurface, { environment })
    );
  };
}

export default {
  apiVersion: '2.0',
  id: 'vibex-plugin-computer-use',
  activate(ctx) {
    const ComputerUseSettingsComponent = createComputerUseSurfaceComponent(
      ctx,
      'computer-use',
      'app.settings.page'
    );
    const ComputerUseStatusComponent = createComputerUseSurfaceComponent(
      ctx,
      'computer-use-status',
      'status.after-mcp'
    );

    ctx.ui.registerSettingsPage({
      id: 'computer-use',
      title: '电脑控制',
      icon: 'terminal',
      component: ComputerUseSettingsComponent,
    });

    ctx.ui.registerStatusBarItem({
      id: 'computer-use-status',
      label: '电脑控制',
      icon: 'monitor',
      slot: 'status.after-mcp',
      component: ComputerUseStatusComponent,
      onActivate: () => {
        ctx.events.emit('computer-use:open-status');
      },
    });

    ctx.ui.registerView({
      id: 'computer-use-status',
      title: '电脑控制',
      slot: 'status.after-mcp',
      component: ComputerUseStatusComponent,
    });

    ctx.ui.registerCommand({
      id: 'vibex.computer-use.emergency-stop',
      title: 'Computer Use: Emergency Stop',
      category: 'Computer Use',
      icon: 'monitor',
      shortcut: 'Ctrl+Alt+Escape',
      handler: async () => {
        ctx.events.emit('computer-use:emergency-stop');
        try {
          await ctx.worker.invoke('surface.createSession', {
            rpcMethod: 'computer.stop',
            rpcParams: {},
          });
        } catch {
          // Daemon may not be running in headless/offline sessions.
        }
      },
    });

    ctx.ui.registerSlashCommand({
      name: 'computer-use',
      description: 'Inspect or automate a desktop application window',
      prompt:
        'Use the Computer Use accessibility snapshot and window tools to:',
    });

    ctx.services.provide('vibex.computer-use', {
      emergencyStopHotkey: 'Ctrl+Alt+Escape',
      async emergencyStop() {
        ctx.events.emit('computer-use:emergency-stop');
        try {
          await ctx.worker.invoke('surface.createSession', {
            rpcMethod: 'computer.stop',
            rpcParams: {},
          });
        } catch {
          // Ignore when daemon is inactive.
        }
        return { stopped: true };
      },
    });
  },
};
