import { type CommandContribution, type ConversationModeContribution, type KanbanViewContribution, type MarkdownRendererContribution, type OverlayContribution, type PanelContribution, type PromptContextContribution, type ProviderContribution, type Registry, type RegistryEntry, type SettingSectionContribution, type SettingsPageContribution, type SlashCommandContribution, type SlotContribution, type ThemeContribution, type UIContributionSlot, type ViewContribution } from './registry.js';
import { type ServiceKey } from './services.js';
export type UseSyncExternalStoreFn = <Snapshot>(subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => Snapshot, getServerSnapshot?: () => Snapshot) => Snapshot;
/**
 * Binds React's `useSyncExternalStore` from the Host singleton so plugin SDK
 * hooks work without bundling a duplicate copy of React in `@vibex/plugin-sdk`.
 */
export declare function bindExternalStoreHook(hook: UseSyncExternalStoreFn | null): void;
export declare function useRegistry<T extends RegistryEntry>(registry: Registry<T>): readonly T[];
export declare function useSlotContributions(slot: UIContributionSlot | (string & {})): readonly SlotContribution[];
export declare function useCommands(): readonly CommandContribution[];
export declare function useViews(slot?: ViewContribution['slot']): readonly ViewContribution[];
export declare function useSettingSections(): readonly SettingSectionContribution[];
export declare function useSlashCommands(): readonly SlashCommandContribution[];
export declare function usePromptContexts(): readonly PromptContextContribution[];
export declare function useProviders(): readonly ProviderContribution[];
export declare function useThemes(): readonly ThemeContribution[];
export declare function useConversationModes(): readonly ConversationModeContribution[];
export declare function useMarkdownRenderers(): readonly MarkdownRendererContribution[];
export declare function useOverlays(): readonly OverlayContribution[];
export declare function usePanels(): readonly PanelContribution[];
export declare function useKanbanViewContributions(): readonly KanbanViewContribution[];
export declare function useSettingsPages(): readonly SettingsPageContribution[];
export declare function usePluginService<T>(key: ServiceKey<T> | string): T | undefined;
