import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
} from 'react';
import browserPlugin from '../../../../plugins/browser/app/main.js';
import BrowserSettingsSurface from '../../../../plugins/browser/src/views/view';
import computerUsePlugin from '../../../../plugins/computer-use/app/main.js';
import ComputerUseSurface from '../../../../plugins/computer-use/src/views/view';
import kanbanViewsPlugin from '../../../../plugins/kanban-views/app/main.js';
import notesPlugin from '../../../../plugins/notes/app/main.js';
import officePlugin from '../../../../plugins/office/app/main.js';
import openConnectorPlugin from '../../../../plugins/open-connector/app/main.js';
import '../../../../plugins/open-connector/runtime/app.css';
import { mountConfigPanel } from '../../../../plugins/open-connector/runtime/config-panel.mjs';
import OpenConnectorConsole from '../../../../plugins/open-connector/src/views/view';
import pluginDevelopmentPlugin from '../../../../plugins/plugin-development/app/main.js';
import promptEnhancerPlugin from '../../../../plugins/prompt-enhancer/app/main.js';
import providerSwitchPlugin from '../../../../plugins/provider-switch/app/main.js';
import remoteSshPlugin from '../../../../plugins/remote-ssh/app/main.js';
import '../../../../plugins/remote-ssh/runtime/app.css';
import { mountRemoteSshApp } from '../../../../plugins/remote-ssh/runtime/app.mjs';
import sciencePlugin from '../../../../plugins/science/app/main.js';
import sessionEnhancePlugin from '../../../../plugins/session-enhance/app/main.js';
import workflowCreatorPlugin from '../../../../plugins/workflow-creator/app/main.js';
import type {
  JsonValue,
  PluginComponent,
  VibeXPluginContext,
  VibexPluginModule,
} from '@vibex/plugin-sdk';
import {
  pluginRuntimeLoader,
  type DeclarativePluginSpec,
} from './PluginRuntimeLoader';
import { ensureCoreFoundationPluginsBootstrapped } from './coreFoundationPlugins';
import { ensureHostProviderServicesRegistered } from './providers/hostProviderServices';

function createEnvironmentViewComponent<TEnv>(
  ctx: VibeXPluginContext,
  defaultSurfaceId: string,
  defaultSlot: string,
  ViewComponent: ComponentType<{ environment: TEnv }>
): PluginComponent {
  return function V2PluginSurfaceAdapter(props: Record<string, unknown>) {
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
      () =>
        ({
          pluginId: ctx.pluginId,
          surfaceId,
          slot,
          workspaceId,
          projectId,
          windowLabel: null,
          invoke: (handler: string, input?: Record<string, unknown> | null) =>
            ctx.worker.invoke(handler, (input ?? {}) as JsonValue),
        }) as unknown as TEnv,
      [projectId, slot, surfaceId, workspaceId]
    );
    return createElement(ViewComponent, { environment });
  };
}

function createOpenConnectorConfigComponent(
  ctx: VibeXPluginContext
): PluginComponent {
  return function OpenConnectorConfigSurface() {
    const rootRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      const node = rootRef.current;
      if (!node) return;
      let dispose: (() => void) | undefined;
      let cancelled = false;
      void mountConfigPanel(node, (handler, input) =>
        ctx.worker.invoke(handler, (input ?? {}) as JsonValue)
      ).then((cleanup) => {
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

function createRemoteSshConnectPanelComponent(
  ctx: VibeXPluginContext
): PluginComponent {
  return function RemoteSshConnectPanelSurface() {
    const rootRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      const node = rootRef.current;
      if (!node) return;
      const controller = new AbortController();
      void mountRemoteSshApp({
        root: node,
        signal: controller.signal,
        bridge: {
          invoke: (handler, input) =>
            ctx.worker.invoke(handler, (input ?? {}) as JsonValue),
          ready: () => undefined,
        },
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

function withOfficialViews(
  baseModule: unknown,
  enhance: (ctx: VibeXPluginContext) => void
): VibexPluginModule {
  const rec = (baseModule ?? {}) as {
    id?: string;
    activate?: (ctx: VibeXPluginContext) => void | Promise<void>;
  };
  return {
    apiVersion: '2.0',
    id: rec.id,
    async activate(ctx: VibeXPluginContext) {
      await rec.activate?.(ctx);
      enhance(ctx);
    },
  };
}

const browserV2Module = withOfficialViews(browserPlugin, (ctx) => {
  const BrowserSettingsComponent = createEnvironmentViewComponent(
    ctx,
    'browser-settings',
    'app.settings.page',
    BrowserSettingsSurface
  );
  ctx.ui.registerSettingsPage({
    id: 'browser-settings',
    title: '浏览器',
    icon: 'globe',
    component: BrowserSettingsComponent,
  });
  ctx.ui.registerView({
    id: 'settings',
    slot: 'plugin.detail.panel',
    component: BrowserSettingsComponent,
  });
});

const computerUseV2Module = withOfficialViews(computerUsePlugin, (ctx) => {
  const ComputerUseSettingsComponent = createEnvironmentViewComponent(
    ctx,
    'computer-use',
    'app.settings.page',
    ComputerUseSurface as ComponentType<{ environment: unknown }>
  );
  const ComputerUseStatusComponent = createEnvironmentViewComponent(
    ctx,
    'computer-use-status',
    'status.after-mcp',
    ComputerUseSurface as ComponentType<{ environment: unknown }>
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
  });
  ctx.ui.registerView({
    id: 'computer-use-status',
    title: '电脑控制',
    slot: 'status.after-mcp',
    component: ComputerUseStatusComponent,
  });
});

const openConnectorV2Module = withOfficialViews(openConnectorPlugin, (ctx) => {
  const ConsoleComponent = createEnvironmentViewComponent(
    ctx,
    'console',
    'app.tab',
    OpenConnectorConsole as ComponentType<{ environment: unknown }>
  );
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
    slot: 'plugin.detail.panel',
    component: ConfigComponent,
  });
});

const remoteSshV2Module = withOfficialViews(remoteSshPlugin, (ctx) => {
  const ConnectPanelComponent = createRemoteSshConnectPanelComponent(ctx);
  ctx.ui.registerSettingsPage({
    id: 'connect-panel',
    title: 'Remote SSH',
    icon: 'cloud',
    component: ConnectPanelComponent,
  });
  ctx.ui.registerView({
    id: 'connect-panel',
    slot: 'plugin.detail.panel',
    component: ConnectPanelComponent,
  });
});

export interface MonorepoPluginBundle {
  id: string;
  dirName: string;
  module: VibexPluginModule;
  spec: DeclarativePluginSpec;
}

export const MONOREPO_OFFICIAL_PLUGIN_BUNDLES: readonly MonorepoPluginBundle[] =
  [
    {
      id: 'vibex.provider-switch',
      dirName: 'provider-switch',
      module: providerSwitchPlugin as VibexPluginModule,
      spec: {
        id: 'vibex.provider-switch',
        name: 'Provider Switch',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.plugin-development',
      dirName: 'plugin-development',
      module: pluginDevelopmentPlugin as VibexPluginModule,
      spec: {
        id: 'vibex.plugin-development',
        name: 'Plugin Development',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.session-enhance',
      dirName: 'session-enhance',
      module: sessionEnhancePlugin as VibexPluginModule,
      spec: {
        id: 'vibex.session-enhance',
        name: 'Session Enhance',
        version: '2.0.0',
        dependencies: [
          {
            kind: 'plugin',
            id: 'vibex.provider-switch',
            versionRange: '^2.0.0',
            required: true,
          },
        ],
      },
    },
    {
      id: 'vibex.browser',
      dirName: 'browser',
      module: browserV2Module,
      spec: {
        id: 'vibex.browser',
        name: 'Browser',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.office',
      dirName: 'office',
      module: officePlugin as VibexPluginModule,
      spec: {
        id: 'vibex.office',
        name: 'Office Suite',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.workflow-creator',
      dirName: 'workflow-creator',
      module: workflowCreatorPlugin as VibexPluginModule,
      spec: {
        id: 'vibex.workflow-creator',
        name: 'Workflow Creator',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.remote-ssh',
      dirName: 'remote-ssh',
      module: remoteSshV2Module,
      spec: {
        id: 'vibex.remote-ssh',
        name: 'Remote SSH',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.open-connector',
      dirName: 'open-connector',
      module: openConnectorV2Module,
      spec: {
        id: 'vibex.open-connector',
        name: 'Open Connector',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.science',
      dirName: 'science',
      module: sciencePlugin as VibexPluginModule,
      spec: {
        id: 'vibex.science',
        name: 'Science Research Suite',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex-plugin-computer-use',
      dirName: 'computer-use',
      module: computerUseV2Module,
      spec: {
        id: 'vibex-plugin-computer-use',
        name: 'Computer Use',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.kanban-views',
      dirName: 'kanban-views',
      module: kanbanViewsPlugin as VibexPluginModule,
      spec: {
        id: 'vibex.kanban-views',
        name: 'Kanban Views',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.notes',
      dirName: 'notes',
      module: notesPlugin as VibexPluginModule,
      spec: {
        id: 'vibex.notes',
        name: 'Workspace Notes',
        version: '2.0.0',
      },
    },
    {
      id: 'vibex.prompt-enhancer',
      dirName: 'prompt-enhancer',
      module: promptEnhancerPlugin as VibexPluginModule,
      spec: {
        id: 'vibex.prompt-enhancer',
        name: 'Prompt Enhancer',
        version: '2.0.0',
      },
    },
  ];

const MONOREPO_BUNDLE_BY_ID = new Map<string, MonorepoPluginBundle>(
  MONOREPO_OFFICIAL_PLUGIN_BUNDLES.map((b) => [b.id, b])
);

export function getMonorepoPluginBundle(
  pluginId: string
): MonorepoPluginBundle | undefined {
  return MONOREPO_BUNDLE_BY_ID.get(pluginId);
}

export async function bootstrapMonorepoOfficialPlugins(options?: {
  onlyIds?: string[];
}): Promise<string[]> {
  ensureHostProviderServicesRegistered();
  ensureCoreFoundationPluginsBootstrapped();
  const filterSet = options?.onlyIds ? new Set(options.onlyIds) : null;
  const activated: string[] = [];
  for (const bundle of MONOREPO_OFFICIAL_PLUGIN_BUNDLES) {
    if (filterSet && !filterSet.has(bundle.id)) continue;
    await pluginRuntimeLoader.activateModule(bundle.id, bundle.module, {
      spec: bundle.spec,
    });
    activated.push(bundle.id);
  }
  return activated;
}
