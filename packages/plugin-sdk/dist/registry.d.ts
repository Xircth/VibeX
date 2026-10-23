export type Disposer = () => void;
export type UIContributionSlot = 'rail.section' | 'panel.left' | 'panel.right' | 'panel.bottom' | 'tab.main' | 'toolbar.left' | 'toolbar.right' | 'status.left' | 'status.main' | 'status.after-mcp' | 'status.right' | 'composer.toolbar' | 'composer.slash' | 'composer.overlay' | 'timeline.card' | 'message.footer' | 'kanban.view' | 'settings.section' | 'settings.page' | 'artifact.editor' | 'artifact.preview' | 'empty-state' | 'floating' | 'toolbar.actions' | 'statusbar.items' | 'rail.sections' | 'composer.actions' | 'composer.mode' | 'markdown.codeblock' | 'global.overlay' | 'message.context-menu' | 'file-tree.context-menu';
export type SlotName = UIContributionSlot | (string & {});
export interface RegistryEntry {
    readonly id: string;
    readonly pluginId?: string;
    readonly order?: number;
}
/**
 * Reactive, snapshot-cached contribution registry compatible with React's
 * `useSyncExternalStore`. Mutations produce a new frozen array reference;
 * reads between mutations return the exact same array reference.
 */
export declare class Registry<T extends RegistryEntry> {
    private readonly items;
    private readonly listeners;
    private snapshot;
    private readonly slotSnapshots;
    readonly subscribe: (listener: () => void) => Disposer;
    readonly getAll: () => readonly T[];
    readonly getSnapshot: () => readonly T[];
    getIds(): readonly string[];
    get(id: string): T | undefined;
    has(id: string): boolean;
    get size(): number;
    getBySlot(slot: string): readonly T[];
    register(item: T, pluginId?: string): Disposer;
    register(id: string, item: T, pluginId?: string): Disposer;
    unregister(id: string): boolean;
    unregisterByPlugin(pluginId: string): number;
    readonly clearByPlugin: (pluginId: string) => number;
    clear(): void;
    private rebuildSnapshot;
    private emit;
}
export type PluginComponent<P = any> = (props: P) => any;
export interface SlotContribution extends RegistryEntry {
    readonly slot: UIContributionSlot | (string & {});
    readonly label?: string;
    readonly tooltip?: string;
    readonly icon?: string;
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
    readonly onActivate?: (context?: Record<string, unknown>) => void | Promise<void>;
    readonly when?: (context: Record<string, unknown>) => boolean;
    readonly metadata?: Record<string, unknown>;
}
export interface CommandContribution extends RegistryEntry {
    readonly title: string;
    readonly category?: string;
    readonly icon?: string;
    readonly shortcut?: string;
    readonly handler: (args?: unknown) => void | Promise<void>;
}
export interface ViewContribution extends RegistryEntry {
    readonly title: string;
    readonly icon?: string;
    readonly kind?: 'panel' | 'tab' | 'kanban' | 'settings' | (string & {});
    readonly slot?: 'tab.main' | 'panel.left' | 'panel.right' | 'panel.bottom' | 'floating' | (string & {});
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
}
export interface SettingSectionContribution extends RegistryEntry {
    readonly title: string;
    readonly description?: string;
    readonly icon?: string;
    readonly category?: string;
    readonly component?: PluginComponent;
}
export interface SlashCommandContribution extends RegistryEntry {
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly prompt?: string;
    readonly argumentHint?: string;
    readonly execute?: (args: string) => void | string | Promise<void | string>;
}
export interface PromptTurnContextInput {
    readonly conversationId: string;
    readonly workspaceId?: string | null;
    readonly projectId?: string | null;
    readonly agentId?: string | null;
    readonly text: string;
}
export interface InternalPromptContributionBlock {
    readonly pluginId: string;
    readonly label?: string | null;
    readonly content: string;
    readonly priority?: number | null;
}
export declare const MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES: number;
export interface PromptTurnContributionResult {
    readonly text?: string;
    readonly prependSystemPrompt?: string;
    readonly appendPrompt?: string;
    readonly hiddenContext?: string;
    readonly content?: string;
    readonly label?: string;
    readonly priority?: number;
    readonly blocks?: ReadonlyArray<{
        readonly label?: string | null;
        readonly content: string;
        readonly priority?: number;
    }>;
}
export interface PromptContextContribution extends RegistryEntry {
    readonly beforeTurn: (turn: PromptTurnContextInput) => Promise<PromptTurnContributionResult | null | void> | PromptTurnContributionResult | null | void;
}
export interface ProviderContribution extends RegistryEntry {
    readonly label: string;
    readonly category?: string;
    readonly baseUrl?: string;
    readonly models?: readonly string[];
    readonly listTemplates?: (agentId: string) => Promise<readonly unknown[]> | readonly unknown[];
    readonly metadata?: Record<string, unknown>;
}
export interface ThemeContribution extends RegistryEntry {
    readonly label: string;
    readonly scheme: 'light' | 'dark';
    readonly cssVariables: Readonly<Record<string, string>>;
}
export interface CapturedInternalMessage {
    readonly pluginId?: string;
    readonly channel: string;
    readonly nonce: string;
    readonly rawPayload: string;
    readonly parsedPayload: unknown;
    readonly conversationId?: string | null;
    readonly turnId?: string | null;
}
export interface InternalMessageCaptureContribution extends RegistryEntry {
    readonly channel: string;
    readonly nonce?: string;
    readonly validate?: (payload: unknown) => boolean;
    readonly onCapture: (message: CapturedInternalMessage) => void | Promise<void>;
}
export interface ConversationModeContribution extends RegistryEntry {
    readonly label: string;
    readonly description?: string;
    readonly icon?: string;
    readonly takeover?: boolean;
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
    readonly onActivate?: (context?: Record<string, unknown>) => void | Promise<void>;
}
export interface MarkdownRendererProps {
    readonly code: string;
    readonly language?: string;
    readonly isStreaming?: boolean;
    readonly workspacePath?: string | null;
    readonly taskAttemptId?: string;
    readonly taskId?: string;
}
export interface MarkdownRendererContribution extends RegistryEntry {
    readonly language: string | readonly string[];
    readonly match?: (code: string, language?: string) => boolean;
    readonly component?: PluginComponent<MarkdownRendererProps>;
    readonly render?: (props: MarkdownRendererProps) => unknown;
}
export interface OverlayContribution extends RegistryEntry {
    readonly title?: string;
    readonly zIndex?: number;
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
    readonly when?: (context: Record<string, unknown>) => boolean;
}
export interface PanelContribution extends RegistryEntry {
    readonly title: string;
    readonly icon?: string;
    readonly zone?: 'left' | 'editor' | 'bottom' | 'session';
    readonly builtin?: boolean;
    readonly multiInstance?: boolean;
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
}
export interface KanbanViewContribution extends RegistryEntry {
    readonly title: string;
    readonly titleKey?: string;
    readonly icon?: string;
    readonly hidesBottomDock?: boolean;
    readonly builtin?: boolean;
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
}
export interface SettingsPageContribution extends RegistryEntry {
    readonly title: string;
    readonly titleKey?: string;
    readonly description?: string;
    readonly descriptionKey?: string;
    readonly group?: string;
    readonly groupLabelKey?: string;
    readonly icon?: string;
    readonly path?: string;
    readonly builtin?: boolean;
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly component?: PluginComponent;
    readonly render?: (props: Record<string, unknown>) => unknown;
}
export declare const slotRegistry: Registry<SlotContribution>;
export declare const commandRegistry: Registry<CommandContribution>;
export declare const viewRegistry: Registry<ViewContribution>;
export declare const settingRegistry: Registry<SettingSectionContribution>;
export declare const slashCommandRegistry: Registry<SlashCommandContribution>;
export declare const promptContextRegistry: Registry<PromptContextContribution>;
export declare const providerRegistry: Registry<ProviderContribution>;
export declare const themeRegistry: Registry<ThemeContribution>;
export declare const internalMessageCaptureRegistry: Registry<InternalMessageCaptureContribution>;
export declare const conversationModeRegistry: Registry<ConversationModeContribution>;
export declare const markdownRegistry: Registry<MarkdownRendererContribution>;
export declare const overlayRegistry: Registry<OverlayContribution>;
export declare const panelRegistry: Registry<PanelContribution>;
export declare const kanbanViewRegistry: Registry<KanbanViewContribution>;
export declare const settingsPageRegistry: Registry<SettingsPageContribution>;
/**
 * Resolves the first matching `MarkdownRendererContribution` for a code block.
 */
export declare function findMarkdownRenderer(code: string, language?: string): MarkdownRendererContribution | undefined;
/**
 * Removes every contribution registered by `pluginId` across all global registries.
 */
export declare function disposePluginRegistrations(pluginId: string): void;
/**
 * Runs all registered `beforeTurn` prompt contributors and `conversation.beforeTurn`
 * waterfall hooks in priority order, returning both legacy text sections and
 * structured `internalPromptContributions` (enforcing the 16 KiB cap).
 */
export declare function resolveBeforeTurnPromptContributions(input: PromptTurnContextInput & {
    readonly internalPromptContributions?: readonly InternalPromptContributionBlock[];
}): Promise<{
    readonly visibleUserText: string;
    readonly agentPromptText: string;
    readonly internalPromptContributions: readonly InternalPromptContributionBlock[];
}>;
/**
 * Runs all registered `beforeTurn` prompt contributors in priority order and merges
 * their prompt additions. Errors in individual plugins are caught and isolated.
 */
export declare function collectBeforeTurnContributions(input: PromptTurnContextInput): Promise<{
    readonly prependSystemPrompts: readonly string[];
    readonly appendPrompts: readonly string[];
    readonly hiddenContexts: readonly string[];
    readonly internalPromptContributions: readonly InternalPromptContributionBlock[];
}>;
export declare function applyBeforeTurnPromptContributions(draftText: string, input: Omit<PromptTurnContextInput, 'text'>): Promise<{
    readonly visibleUserText: string;
    readonly agentPromptText: string;
    readonly contributions: {
        readonly prependSystemPrompts: readonly string[];
        readonly appendPrompts: readonly string[];
        readonly hiddenContexts: readonly string[];
        readonly internalPromptContributions: readonly InternalPromptContributionBlock[];
    };
}>;
/**
 * Dispatches a captured internal message (from either the Rust projector event stream
 * or local extraction) to all matching `InternalMessageCaptureContribution` handlers.
 */
export declare function dispatchCapturedInternalMessage(msg: CapturedInternalMessage): void;
/**
 * Strips `<vibex-internal-meta>`, `<!--vibex-internal:channel:nonce ...-->`, and
 * fenced `vibex-internal:channel:nonce` blocks from assistant text so internal
 * plugin protocol payloads never leak into the user-visible chat timeline, while
 * dispatching matching payloads to registered `InternalMessageCaptureContribution`s.
 */
export declare function extractAndStripInternalMessages(text: string, options?: {
    conversationId?: string | null;
    turnId?: string | null;
    dispatch?: boolean;
}): {
    readonly cleanedText: string;
    readonly captured: readonly CapturedInternalMessage[];
    readonly hasIncompleteTrailingTag: boolean;
};
