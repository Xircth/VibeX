import type { JsonValue, PluginContext } from './protocol.js';
import { type VibeXPluginContext, type VibeXPluginDefinition } from './context.js';
import { type CommandContribution, commandRegistry, type ConversationModeContribution, conversationModeRegistry, type Disposer, type KanbanViewContribution, kanbanViewRegistry, type MarkdownRendererContribution, markdownRegistry, type OverlayContribution, overlayRegistry, type PanelContribution, panelRegistry, type SettingSectionContribution, settingRegistry, type SettingsPageContribution, settingsPageRegistry, type SlashCommandContribution, slashCommandRegistry, type SlotContribution, slotRegistry, type ViewContribution, viewRegistry } from './registry.js';
import { type ActivatedPluginWorker, type PluginHostClient, type PluginWorkerDefinition } from './worker.js';
export interface WorkerHarness extends ActivatedPluginWorker {
    readonly hostCalls: ReadonlyArray<{
        capability: string;
        operation: string;
        input: JsonValue;
    }>;
}
export declare function createWorkerHarness(definition: PluginWorkerDefinition, options?: {
    context?: Partial<PluginContext>;
    host?: PluginHostClient;
}): Promise<WorkerHarness>;
export interface GenerationHarness {
    readonly generation: number;
    readonly handlers: readonly string[];
    invoke(handler: string, input: JsonValue): Promise<JsonValue>;
    activateCandidate(definition: PluginWorkerDefinition): Promise<number>;
    dispose(): Promise<void>;
}
export declare function createGenerationHarness(definition: PluginWorkerDefinition, options?: {
    context?: Partial<PluginContext>;
    host?: PluginHostClient;
    requiredHandlers?: readonly string[];
}): Promise<GenerationHarness>;
export interface PluginTestHarness {
    readonly pluginId: string;
    readonly ctx: VibeXPluginContext;
    readonly hostCalls: ReadonlyArray<{
        capability: string;
        operation: string;
        input: JsonValue;
    }>;
    readonly registries: {
        readonly slot: typeof slotRegistry;
        readonly command: typeof commandRegistry;
        readonly view: typeof viewRegistry;
        readonly panel: typeof panelRegistry;
        readonly kanbanView: typeof kanbanViewRegistry;
        readonly settingsPage: typeof settingsPageRegistry;
        readonly setting: typeof settingRegistry;
        readonly slashCommand: typeof slashCommandRegistry;
        readonly markdown: typeof markdownRegistry;
        readonly conversationMode: typeof conversationModeRegistry;
        readonly overlay: typeof overlayRegistry;
    };
    activate(plugin?: VibeXPluginDefinition | ((ctx: VibeXPluginContext) => void | Disposer | Promise<void | Disposer>)): Promise<void>;
    getSlots(slot?: string): readonly SlotContribution[];
    getCommands(): readonly CommandContribution[];
    getViews(): readonly ViewContribution[];
    getPanels(): readonly PanelContribution[];
    getKanbanViews(): readonly KanbanViewContribution[];
    getSettingsPages(): readonly SettingsPageContribution[];
    getSettingsSections(): readonly SettingSectionContribution[];
    getSlashCommands(): readonly SlashCommandContribution[];
    getMarkdownRenderers(): readonly MarkdownRendererContribution[];
    getConversationModes(): readonly ConversationModeContribution[];
    getOverlays(): readonly OverlayContribution[];
    dispose(): Promise<void>;
}
export type PluginTestTarget = VibeXPluginDefinition | ((ctx: VibeXPluginContext) => void | Disposer | Promise<void | Disposer>);
export interface PluginTestHarnessConfig {
    pluginId?: string;
    generation?: number;
    host?: PluginHostClient;
    plugin?: PluginTestTarget;
}
export type PluginTestHarnessOptions = PluginTestHarnessConfig | PluginTestTarget;
export declare function createPluginTestHarness(optionsOrPlugin?: PluginTestHarnessOptions): PluginTestHarness;
