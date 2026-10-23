import type {
  VibeXPluginContext,
  VibexPluginModule,
} from '@vibex/plugin-sdk';
import {
  pluginRuntimeLoader,
  unloadPluginRuntime,
  type DeclarativePluginSpec,
} from './PluginRuntimeLoader';
import { ensureCoreFoundationPluginsBootstrapped } from './coreFoundationPlugins';
import { ensureHostProviderServicesRegistered } from './providers/hostProviderServices';

type RawPluginModuleExport =
  | VibexPluginModule
  | { default: VibexPluginModule };

export type MonorepoPluginModuleLoader = () => Promise<RawPluginModuleExport>;

interface MonorepoPluginDescriptor {
  readonly dirName: string;
  readonly name: string;
  readonly version: string;
  readonly dependencies?: DeclarativePluginSpec['dependencies'];
  readonly loader: MonorepoPluginModuleLoader;
}

function resolveMonorepoPluginId(dirName: string): string {
  return dirName === 'computer-use'
    ? ['vibex-plugin', dirName].join('-')
    : `vibex.${dirName}`;
}

const MONOREPO_PLUGIN_DESCRIPTORS: readonly MonorepoPluginDescriptor[] = [
  {
    dirName: 'provider-switch',
    name: 'Provider Switch',
    version: '2.0.0',
    loader: () => import('../../../../plugins/provider-switch/app/main.js'),
  },
  {
    dirName: 'plugin-development',
    name: 'Plugin Development',
    version: '2.0.0',
    loader: () => import('../../../../plugins/plugin-development/app/main.js'),
  },
  {
    dirName: 'session-enhance',
    name: 'Session Enhance',
    version: '2.0.0',
    dependencies: [
      {
        kind: 'plugin',
        id: resolveMonorepoPluginId('provider-switch'),
        versionRange: '^2.0.0',
        required: true,
      },
    ],
    loader: () => import('../../../../plugins/session-enhance/app/main.js'),
  },
  {
    dirName: 'browser',
    name: 'Browser',
    version: '2.0.0',
    loader: () => import('../../../../plugins/browser/app/main.js'),
  },
  {
    dirName: 'office',
    name: 'Office Suite',
    version: '2.0.0',
    loader: () => import('../../../../plugins/office/app/main.js'),
  },
  {
    dirName: 'workflow-creator',
    name: 'Workflow Creator',
    version: '2.0.0',
    loader: () => import('../../../../plugins/workflow-creator/app/main.js'),
  },
  {
    dirName: 'remote-ssh',
    name: 'Remote SSH',
    version: '2.0.0',
    loader: () => import('../../../../plugins/remote-ssh/app/main.js'),
  },
  {
    dirName: 'open-connector',
    name: 'Open Connector',
    version: '2.0.0',
    loader: () => import('../../../../plugins/open-connector/app/main.js'),
  },
  {
    dirName: 'science',
    name: 'Science Research Suite',
    version: '2.0.0',
    loader: () => import('../../../../plugins/science/app/main.js'),
  },
  {
    dirName: 'computer-use',
    name: 'Computer Use',
    version: '2.0.0',
    loader: () => import('../../../../plugins/computer-use/app/main.js'),
  },
  {
    dirName: 'kanban-views',
    name: 'Kanban Views',
    version: '2.0.0',
    loader: () => import('../../../../plugins/kanban-views/app/main.js'),
  },
  {
    dirName: 'notes',
    name: 'Workspace Notes',
    version: '2.0.0',
    loader: () => import('../../../../plugins/notes/app/main.js'),
  },
  {
    dirName: 'prompt-enhancer',
    name: 'Prompt Enhancer',
    version: '2.0.0',
    loader: () => import('../../../../plugins/prompt-enhancer/app/main.js'),
  },
];

function unwrapPluginModule(raw: RawPluginModuleExport): VibexPluginModule {
  if (
    raw &&
    typeof raw === 'object' &&
    'default' in raw &&
    raw.default &&
    typeof raw.default === 'object'
  ) {
    return raw.default;
  }
  return raw as VibexPluginModule;
}

const loadedModulesById = new Map<string, VibexPluginModule>();
const moduleLoadCountById = new Map<string, number>();

export interface MonorepoPluginBundle {
  id: string;
  dirName: string;
  spec: DeclarativePluginSpec;
  loadModule: () => Promise<VibexPluginModule>;
  module: VibexPluginModule;
}

function createMonorepoPluginBundle(
  descriptor: MonorepoPluginDescriptor
): MonorepoPluginBundle {
  const pluginId = resolveMonorepoPluginId(descriptor.dirName);
  const spec: DeclarativePluginSpec = {
    id: pluginId,
    name: descriptor.name,
    version: descriptor.version,
    ...(descriptor.dependencies
      ? { dependencies: descriptor.dependencies }
      : {}),
  };
  const bundle: MonorepoPluginBundle = {
    id: pluginId,
    dirName: descriptor.dirName,
    spec,
    async loadModule(): Promise<VibexPluginModule> {
      const prevCount = moduleLoadCountById.get(pluginId) ?? 0;
      moduleLoadCountById.set(pluginId, prevCount + 1);
      const raw = await descriptor.loader();
      const mod = unwrapPluginModule(raw);
      loadedModulesById.set(pluginId, mod);
      return mod;
    },
    module: {
      apiVersion: '2.0',
      id: pluginId,
      async activate(ctx: VibeXPluginContext) {
        const resolved = await bundle.loadModule();
        return await resolved.activate(ctx);
      },
      async deactivate() {
        const cached = loadedModulesById.get(pluginId);
        await cached?.deactivate?.();
      },
    },
  };
  return bundle;
}

export const MONOREPO_OFFICIAL_PLUGIN_BUNDLES: readonly MonorepoPluginBundle[] =
  MONOREPO_PLUGIN_DESCRIPTORS.map((descriptor) =>
    createMonorepoPluginBundle(descriptor)
  );

const MONOREPO_BUNDLE_BY_ID = new Map<string, MonorepoPluginBundle>(
  MONOREPO_OFFICIAL_PLUGIN_BUNDLES.map((b) => [b.id, b])
);

export function getMonorepoPluginBundle(
  pluginId: string
): MonorepoPluginBundle | undefined {
  return MONOREPO_BUNDLE_BY_ID.get(pluginId);
}

export function isMonorepoPluginModuleLoaded(pluginId: string): boolean {
  return loadedModulesById.has(pluginId);
}

export function getMonorepoPluginLoadCount(pluginId: string): number {
  return moduleLoadCountById.get(pluginId) ?? 0;
}

export function resetMonorepoPluginLoaderStateForTest(): void {
  loadedModulesById.clear();
  moduleLoadCountById.clear();
}

export async function loadMonorepoPluginModule(
  pluginId: string
): Promise<VibexPluginModule | undefined> {
  const bundle = MONOREPO_BUNDLE_BY_ID.get(pluginId);
  if (!bundle) return undefined;
  return await bundle.loadModule();
}

export async function activateMonorepoPlugin(
  pluginId: string,
  options?: { generation?: number }
): Promise<boolean> {
  ensureHostProviderServicesRegistered();
  ensureCoreFoundationPluginsBootstrapped();
  const bundle = MONOREPO_BUNDLE_BY_ID.get(pluginId);
  if (!bundle) return false;
  const loadedModule = await bundle.loadModule();
  await pluginRuntimeLoader.activateModule(bundle.id, loadedModule, {
    spec: bundle.spec,
    generation: options?.generation,
  });
  return true;
}

export function deactivateMonorepoPlugin(pluginId: string): void {
  unloadPluginRuntime(pluginId);
}

export async function reloadMonorepoPlugin(
  pluginId: string,
  options?: { generation?: number }
): Promise<boolean> {
  unloadPluginRuntime(pluginId);
  return await activateMonorepoPlugin(pluginId, options);
}

export async function syncMonorepoPluginRuntime(
  pluginId: string,
  enabled: boolean,
  options?: { generation?: number }
): Promise<void> {
  if (!enabled) {
    unloadPluginRuntime(pluginId);
    return;
  }
  await activateMonorepoPlugin(pluginId, options);
}

export interface BootstrapMonorepoPluginsOptions {
  onlyIds?: Iterable<string>;
  enabledIds?: Iterable<string>;
  disabledIds?: Iterable<string>;
  isPluginEnabled?: (pluginId: string) => boolean;
  plugins?: ReadonlyArray<{
    id?: string;
    pluginId?: string;
    enabled?: boolean;
    uninstalled?: boolean;
  }>;
  generation?: number;
}

function shouldEnableBundle(
  pluginId: string,
  options?: BootstrapMonorepoPluginsOptions,
  onlySet?: Set<string> | null,
  enabledSet?: Set<string> | null,
  disabledSet?: Set<string> | null,
  pluginStateMap?: Map<string, boolean> | null
): boolean {
  if (onlySet && !onlySet.has(pluginId)) {
    return false;
  }
  if (disabledSet && disabledSet.has(pluginId)) {
    return false;
  }
  if (enabledSet && !enabledSet.has(pluginId)) {
    return false;
  }
  if (pluginStateMap) {
    const state = pluginStateMap.get(pluginId);
    if (state === undefined || state === false) {
      return false;
    }
  }
  if (options?.isPluginEnabled && !options.isPluginEnabled(pluginId)) {
    return false;
  }
  return true;
}

export async function bootstrapMonorepoOfficialPlugins(
  options?: BootstrapMonorepoPluginsOptions
): Promise<string[]> {
  ensureHostProviderServicesRegistered();
  ensureCoreFoundationPluginsBootstrapped();

  const onlySet = options?.onlyIds ? new Set(options.onlyIds) : null;
  const enabledSet = options?.enabledIds ? new Set(options.enabledIds) : null;
  const disabledSet = options?.disabledIds
    ? new Set(options.disabledIds)
    : null;
  let pluginStateMap: Map<string, boolean> | null = null;
  if (options?.plugins) {
    pluginStateMap = new Map<string, boolean>();
    for (const entry of options.plugins) {
      const id = entry.id ?? entry.pluginId;
      if (!id) continue;
      pluginStateMap.set(id, entry.enabled !== false && !entry.uninstalled);
    }
  }

  const activated: string[] = [];
  for (const bundle of MONOREPO_OFFICIAL_PLUGIN_BUNDLES) {
    if (onlySet && !onlySet.has(bundle.id)) {
      continue;
    }
    const enabled = shouldEnableBundle(
      bundle.id,
      options,
      onlySet,
      enabledSet,
      disabledSet,
      pluginStateMap
    );
    if (!enabled) {
      unloadPluginRuntime(bundle.id);
      continue;
    }
    const loadedModule = await bundle.loadModule();
    await pluginRuntimeLoader.activateModule(bundle.id, loadedModule, {
      spec: bundle.spec,
      generation: options?.generation,
    });
    activated.push(bundle.id);
  }
  return activated;
}
