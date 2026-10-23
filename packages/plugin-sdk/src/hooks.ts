import {
  type CommandContribution,
  commandRegistry,
  type ConversationModeContribution,
  conversationModeRegistry,
  type KanbanViewContribution,
  kanbanViewRegistry,
  type MarkdownRendererContribution,
  markdownRegistry,
  type OverlayContribution,
  overlayRegistry,
  type PanelContribution,
  panelRegistry,
  type PromptContextContribution,
  promptContextRegistry,
  type ProviderContribution,
  providerRegistry,
  type Registry,
  type RegistryEntry,
  type SettingSectionContribution,
  settingRegistry,
  type SettingsPageContribution,
  settingsPageRegistry,
  type SlashCommandContribution,
  slashCommandRegistry,
  type SlotContribution,
  slotRegistry,
  type ThemeContribution,
  themeRegistry,
  type UIContributionSlot,
  type ViewContribution,
  viewRegistry,
} from './registry.js';
import { serviceContainer, type ServiceKey } from './services.js';

export type UseSyncExternalStoreFn = <Snapshot>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot
) => Snapshot;

let boundUseSyncExternalStore: UseSyncExternalStoreFn | null = null;

/**
 * Binds React's `useSyncExternalStore` from the Host singleton so plugin SDK
 * hooks work without bundling a duplicate copy of React in `@vibex/plugin-sdk`.
 */
export function bindExternalStoreHook(
  hook: UseSyncExternalStoreFn | null
): void {
  boundUseSyncExternalStore = hook;
}

function resolveExternalStoreHook(): UseSyncExternalStoreFn | null {
  if (boundUseSyncExternalStore) {
    return boundUseSyncExternalStore;
  }
  const globalReact = (
    globalThis as unknown as {
      __VIBEX_REACT__?: { useSyncExternalStore?: UseSyncExternalStoreFn };
    }
  ).__VIBEX_REACT__;
  if (typeof globalReact?.useSyncExternalStore === 'function') {
    return globalReact.useSyncExternalStore;
  }
  return null;
}

function readExternalStore<Snapshot>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot
): Snapshot {
  const hook = resolveExternalStoreHook();
  if (hook) {
    return hook(subscribe, getSnapshot, getSnapshot);
  }
  return getSnapshot();
}

export function useRegistry<T extends RegistryEntry>(
  registry: Registry<T>
): readonly T[] {
  return readExternalStore(registry.subscribe, registry.getAll);
}

export function useSlotContributions(
  slot: UIContributionSlot | (string & {})
): readonly SlotContribution[] {
  return readExternalStore(slotRegistry.subscribe, () =>
    slotRegistry.getBySlot(slot)
  );
}

export function useCommands(): readonly CommandContribution[] {
  return useRegistry(commandRegistry);
}

export function useViews(
  slot?: ViewContribution['slot']
): readonly ViewContribution[] {
  return readExternalStore(viewRegistry.subscribe, () =>
    slot ? viewRegistry.getBySlot(slot) : viewRegistry.getAll()
  );
}

export function useSettingSections(): readonly SettingSectionContribution[] {
  return useRegistry(settingRegistry);
}

export function useSlashCommands(): readonly SlashCommandContribution[] {
  return useRegistry(slashCommandRegistry);
}

export function usePromptContexts(): readonly PromptContextContribution[] {
  return useRegistry(promptContextRegistry);
}

export function useProviders(): readonly ProviderContribution[] {
  return useRegistry(providerRegistry);
}

export function useThemes(): readonly ThemeContribution[] {
  return useRegistry(themeRegistry);
}

export function useConversationModes(): readonly ConversationModeContribution[] {
  return useRegistry(conversationModeRegistry);
}

export function useMarkdownRenderers(): readonly MarkdownRendererContribution[] {
  return useRegistry(markdownRegistry);
}

export function useOverlays(): readonly OverlayContribution[] {
  return useRegistry(overlayRegistry);
}

export function usePanels(): readonly PanelContribution[] {
  return useRegistry(panelRegistry);
}

export function useKanbanViewContributions(): readonly KanbanViewContribution[] {
  return useRegistry(kanbanViewRegistry);
}

export function useSettingsPages(): readonly SettingsPageContribution[] {
  return useRegistry(settingsPageRegistry);
}

export function usePluginService<T>(
  key: ServiceKey<T> | string
): T | undefined {
  return readExternalStore(
    (onChange) => serviceContainer.onServiceChange(key, onChange),
    () => serviceContainer.inject(key)
  );
}
