import {
  commandRegistry,
  kanbanViewRegistry,
  panelRegistry,
  serviceContainer,
  settingsPageRegistry,
  slashCommandRegistry,
  slotRegistry,
  viewRegistry,
  type VibeXPluginContext,
  type VibexPluginModule,
} from '@vibex/plugin-sdk';
import { useEffect, useState } from 'react';

import {
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS,
  CORE_PLUGIN_PLANES,
  type CoreFoundationArtworkKey,
  type CoreFoundationPluginDescriptor,
  type CoreFoundationServiceBase,
  type CorePluginPartDescriptor,
  type CorePluginPlane,
  type CorePluginPlaneMetadata,
} from './coreFoundationCatalogData';
import {
  isPluginRuntimeActive,
  loadPluginRuntime,
  loadSystemBundleProfile,
  type PluginProfileEntry,
  type PluginRuntimeSource,
  registerSystemBundleProfile,
} from './PluginRuntimeLoader';

export {
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS,
  CORE_PLUGIN_PLANES,
  type CoreFoundationArtworkKey,
  type CoreFoundationPluginDescriptor,
  type CoreFoundationServiceBase,
  type CorePluginPartDescriptor,
  type CorePluginPlane,
  type CorePluginPlaneMetadata,
};

const CORE_DESCRIPTOR_BY_ID = new Map<string, CoreFoundationPluginDescriptor>(
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS.map((d) => [d.id, d])
);

export function getCoreFoundationPluginDescriptor(
  pluginId: string
): CoreFoundationPluginDescriptor | undefined {
  return CORE_DESCRIPTOR_BY_ID.get(pluginId);
}

export function createCoreFoundationModule(
  descriptor: CoreFoundationPluginDescriptor
): VibexPluginModule {
  return {
    apiVersion: '2.0',
    id: descriptor.id,
    activate(ctx: VibeXPluginContext) {
      descriptor.onActivate(ctx);
      for (const serviceKey of descriptor.provides) {
        if (!serviceContainer.has(serviceKey)) {
          ctx.services.provide(serviceKey, {
            pluginId: descriptor.id,
            packageName: descriptor.packageName,
            serviceKey,
            plane: descriptor.plane,
            version: descriptor.version,
            bundle: 'system',
            locked: true,
            active: true,
          });
        }
      }
    },
  };
}

export function getCoreFoundationPluginSource(
  pluginId: string
): PluginRuntimeSource {
  const descriptor = CORE_DESCRIPTOR_BY_ID.get(pluginId);
  if (!descriptor) {
    throw new Error(`Unknown core foundation plugin "${pluginId}"`);
  }
  return {
    kind: 'module',
    module: createCoreFoundationModule(descriptor),
    spec: {
      id: descriptor.id,
      name: descriptor.titleEn,
      version: descriptor.version,
      bundle: 'system',
      locked: true,
    },
  };
}

export const SYSTEM_BUNDLE_PROFILE_ENTRIES: readonly PluginProfileEntry[] =
  CORE_FOUNDATION_PLUGIN_DESCRIPTORS.map((descriptor) => ({
    id: descriptor.id,
    bundle: 'system' as const,
    locked: true,
    source: getCoreFoundationPluginSource(descriptor.id),
  }));

registerSystemBundleProfile(SYSTEM_BUNDLE_PROFILE_ENTRIES);

let coreBootstrapped = false;

export async function loadCoreFoundationPlugin(
  pluginId: string
): Promise<() => void> {
  return await loadPluginRuntime(
    pluginId,
    getCoreFoundationPluginSource(pluginId),
    {
      bundle: 'system',
      locked: true,
    }
  );
}

export async function bootstrapCoreFoundationPlugins(options?: {
  force?: boolean;
  onlyIds?: readonly string[];
}): Promise<string[]> {
  registerSystemBundleProfile(SYSTEM_BUNDLE_PROFILE_ENTRIES);
  loadSystemBundleProfile({
    force: options?.force ?? true,
    onlyIds: options?.onlyIds,
  });
  coreBootstrapped = true;
  const allowedIds = options?.onlyIds ? new Set(options.onlyIds) : null;
  return CORE_FOUNDATION_PLUGIN_DESCRIPTORS.filter(
    (d) => !allowedIds || allowedIds.has(d.id)
  ).map((d) => d.id);
}

export function ensureCoreFoundationPluginsBootstrapped(options?: {
  force?: boolean;
  onlyIds?: readonly string[];
}): void {
  const anyActive = CORE_FOUNDATION_PLUGIN_DESCRIPTORS.some((d) =>
    isPluginRuntimeActive(d.id)
  );
  if (
    coreBootstrapped &&
    anyActive &&
    !options?.force &&
    !options?.onlyIds?.length
  ) {
    return;
  }
  coreBootstrapped = true;
  registerSystemBundleProfile(SYSTEM_BUNDLE_PROFILE_ENTRIES);
  loadSystemBundleProfile({
    force: options?.force ?? !anyActive,
    onlyIds: options?.onlyIds,
  });
}

export interface CorePluginRuntimeSnapshot {
  readonly descriptor: CoreFoundationPluginDescriptor;
  readonly bundle: 'system';
  readonly locked: true;
  readonly canUninstall: false;
  readonly active: boolean;
  readonly providedCount: number;
  readonly dependenciesSatisfied: boolean;
  readonly liveRegistrationCount: number;
}

function countLiveRegistrationsForPlugin(
  descriptor: CoreFoundationPluginDescriptor
): number {
  const pluginId = descriptor.id;
  const ownedPanels = panelRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedKanbanViews = kanbanViewRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedSettingsPages = settingsPageRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedCommands = commandRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedSlashCommands = slashCommandRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedSlots = slotRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedViews = viewRegistry
    .getAll()
    .filter((item) => item.pluginId === pluginId).length;
  const ownedCount =
    ownedPanels +
    ownedKanbanViews +
    ownedSettingsPages +
    ownedCommands +
    ownedSlashCommands +
    ownedSlots +
    ownedViews;

  return Math.max(descriptor.parts.length, ownedCount);
}

export function getCoreFoundationInventory(): CorePluginRuntimeSnapshot[] {
  ensureCoreFoundationPluginsBootstrapped();
  return CORE_FOUNDATION_PLUGIN_DESCRIPTORS.map((descriptor) => {
    const providedCount = descriptor.provides.filter((key) =>
      serviceContainer.has(key)
    ).length;
    const dependenciesSatisfied = descriptor.injects.every((key) =>
      serviceContainer.has(key)
    );
    const active =
      isPluginRuntimeActive(descriptor.id) ||
      providedCount > 0 ||
      serviceContainer.has(`plugin.active:${descriptor.id}`);

    const liveRegistrationCount = active
      ? countLiveRegistrationsForPlugin(descriptor)
      : 0;

    return {
      descriptor,
      bundle: 'system',
      locked: true,
      canUninstall: false,
      active,
      providedCount,
      dependenciesSatisfied,
      liveRegistrationCount,
    };
  });
}

export function useCoreFoundationInventory(): CorePluginRuntimeSnapshot[] {
  const [inventory, setInventory] = useState<CorePluginRuntimeSnapshot[]>(() =>
    getCoreFoundationInventory()
  );

  useEffect(() => {
    setInventory(getCoreFoundationInventory());
    return serviceContainer.subscribe(() => {
      setInventory(getCoreFoundationInventory());
    });
  }, []);

  return inventory;
}
