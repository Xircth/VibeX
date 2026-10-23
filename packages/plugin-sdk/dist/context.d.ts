import type { JsonValue } from './protocol.js';
import { type CapturedInternalMessage, type CommandContribution, type ConversationModeContribution, type Disposer, type InternalMessageCaptureContribution, type InternalPromptContributionBlock, type KanbanViewContribution, type MarkdownRendererContribution, type OverlayContribution, type PanelContribution, type PromptContextContribution, type PromptTurnContextInput, type PromptTurnContributionResult, type ProviderContribution, type SettingSectionContribution, type SettingsPageContribution, type SlashCommandContribution, type SlotContribution, type ThemeContribution, type ViewContribution } from './registry.js';
import { EffectScope, type ServiceKey, type WaterfallInterceptor } from './services.js';
export interface HostCallRequestObject {
    readonly pluginId: string;
    readonly capability: string;
    readonly operation: string;
    readonly input?: JsonValue;
}
export type HostCallTransport = (<T = JsonValue>(pluginId: string, capability: string, operation: string, input?: JsonValue) => Promise<T>) | (<T = JsonValue>(request: HostCallRequestObject) => Promise<T>);
export type WorkerInvokeTransport = <T = JsonValue>(pluginId: string, handler: string, input?: JsonValue) => Promise<T>;
export declare function setDefaultHostCallTransport(transport: HostCallTransport | null): void;
export declare function setDefaultWorkerInvokeTransport(transport: WorkerInvokeTransport | null): void;
export declare function qualifyPluginContributionId(pluginId: string, rawId: string): string;
export interface PluginKvClient {
    get<T = JsonValue>(key: string): Promise<T | null>;
    put<T extends JsonValue = JsonValue>(key: string, value: T): Promise<T>;
    set<T extends JsonValue = JsonValue>(key: string, value: T): Promise<T>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
    clear(): Promise<{
        removed: number;
    }>;
}
export interface PluginSettingsClient {
    get<T = JsonValue>(): Promise<T>;
    put<T extends JsonValue = JsonValue>(value: T): Promise<T>;
    set<T extends JsonValue = JsonValue>(value: T): Promise<T>;
}
export interface PluginNetworkFetchInput {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: JsonValue;
    readonly timeoutMs?: number;
}
export interface PluginNetworkFetchResponse {
    readonly status: number;
    readonly ok: boolean;
    readonly statusText: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly bodyText?: string;
    readonly bodyBase64?: string;
}
export interface PluginExecRunInput {
    readonly program: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
}
export interface PluginExecRunOutput {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly success: boolean;
}
export interface PluginExecSpawnInput {
    readonly program: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
}
export interface PluginExecSpawnOutput {
    readonly processId: string;
    readonly pid: number | null;
}
export interface PluginExecStatusOutput {
    readonly processId: string;
    readonly pid?: number | null;
    readonly running: boolean;
    readonly exitCode: number | null;
}
export interface PluginToastInput {
    readonly title: string;
    readonly message?: string;
    readonly variant?: 'info' | 'success' | 'warning' | 'error';
    readonly durationMs?: number;
}
export interface PluginUiNamespace {
    registerSlot(contribution: Omit<SlotContribution, 'pluginId'>): Disposer;
    registerView(contribution: Omit<ViewContribution, 'pluginId' | 'title'> & {
        title?: string;
    }): Disposer;
    registerPanel(contribution: Omit<PanelContribution, 'pluginId'> & {
        slot?: ViewContribution['slot'];
    }): Disposer;
    registerTab(contribution: Omit<ViewContribution, 'pluginId' | 'kind'>): Disposer;
    registerKanbanView(contribution: Omit<KanbanViewContribution, 'pluginId'>): Disposer;
    registerSettingsPage(contribution: Omit<SettingsPageContribution, 'pluginId'>): Disposer;
    registerSettingsSection(contribution: Omit<SettingSectionContribution, 'pluginId'>): Disposer;
    registerCommand(contribution: Omit<CommandContribution, 'pluginId'>): Disposer;
    registerToolbarItem(contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
        slot?: SlotContribution['slot'];
    }): Disposer;
    registerStatusBarItem(contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
        slot?: SlotContribution['slot'];
    }): Disposer;
    registerStatusItem(contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
        slot?: SlotContribution['slot'];
    }): Disposer;
    registerRailSection(contribution: Omit<SlotContribution, 'pluginId' | 'slot'>): Disposer;
    registerComposerAction(contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
        title?: string;
        prompt?: string;
    }): Disposer;
    registerComposerSlash(contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
        id?: string;
    }): Disposer;
    registerSlashCommand(contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
        id?: string;
    }): Disposer;
    registerConversationMode(contribution: Omit<ConversationModeContribution, 'pluginId'> & {
        label?: string;
        title?: string;
    }): Disposer;
    registerMarkdownRenderer(contribution: Omit<MarkdownRendererContribution, 'pluginId'> & {
        language?: string | readonly string[];
    }): Disposer;
    registerTimelineCard(contribution: Omit<SlotContribution, 'pluginId' | 'slot'>): Disposer;
    registerOverlay(contribution: Omit<OverlayContribution, 'pluginId'>): Disposer;
    registerContextMenu(contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
        slot?: 'message.context-menu' | 'file-tree.context-menu';
        group?: string;
        action?: (context: Record<string, unknown>) => void | Promise<void>;
    }): Disposer;
}
export interface AfterTurnHookEvent {
    readonly conversationId: string;
    readonly turnId: string;
    readonly status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | string;
    readonly assistantText?: string;
    readonly capturedMessages?: readonly CapturedInternalMessage[];
}
export interface RuntimeEventHookPayload {
    readonly conversationId: string;
    readonly turnId?: string | null;
    readonly sequence?: number;
    readonly eventKind: string;
    readonly event: JsonValue;
    readonly createdAt?: string;
    readonly [key: string]: unknown;
}
export type BeforeTurnHookPayload = PromptTurnContextInput & {
    internalPromptContributions?: InternalPromptContributionBlock[];
};
export interface PluginHooksNamespace {
    beforeTurn(fn: (turn: BeforeTurnHookPayload) => Promise<PromptTurnContributionResult | string | null | void> | PromptTurnContributionResult | string | null | void, order?: number): Disposer;
    beforeTurn<TPayload = BeforeTurnHookPayload, TResult = PromptTurnContributionResult | string | void | TPayload>(fn: WaterfallInterceptor<TPayload, TResult>, order?: number): Disposer;
    afterTurn(fn: (event: AfterTurnHookEvent) => void | Promise<void>, order?: number): Disposer;
    afterTurn<TPayload = AfterTurnHookEvent, TResult = TPayload>(fn: WaterfallInterceptor<TPayload, TResult>, order?: number): Disposer;
    onRuntimeEvent(fn: (event: RuntimeEventHookPayload) => void | Promise<void>, order?: number): Disposer;
    onRuntimeEvent<TPayload = RuntimeEventHookPayload, TResult = TPayload>(fn: WaterfallInterceptor<TPayload, TResult>, order?: number): Disposer;
    captureInternalMessage(contribution: Omit<InternalMessageCaptureContribution, 'pluginId' | 'id'> & {
        id?: string;
    }): Disposer;
    captureInternalMessage(channel: string, onCapture: (message: CapturedInternalMessage) => void | Promise<void>, options?: {
        id?: string;
        nonce?: string;
        validate?: (payload: unknown) => boolean;
        order?: number;
    }): Disposer;
    intercept<TPayload = unknown, TResult = unknown>(hookName: string, fn: WaterfallInterceptor<TPayload, TResult>, order?: number): Disposer;
}
export interface PluginServicesNamespace {
    provide<T>(key: ServiceKey<T> | string, implementation: T): Disposer;
    get<T>(key: ServiceKey<T> | string): T | undefined;
    inject<T>(key: ServiceKey<T> | string): T | undefined;
    inject(deps: ReadonlyArray<ServiceKey<unknown> | string>, effect: (resolved: any) => void | Disposer): Disposer;
    require<T>(key: ServiceKey<T> | string): T;
    intercept<TPayload = unknown, TResult = unknown>(hookName: string, fn: WaterfallInterceptor<TPayload, TResult> | ((previousService: any) => any), order?: number): Disposer;
    onChange<T>(key: ServiceKey<T> | string, listener: () => void): Disposer;
}
export interface PluginHostNamespace {
    call<T = JsonValue>(capability: string, operation: string, input?: JsonValue): Promise<T>;
    readonly storage: {
        readonly kv: PluginKvClient;
        readonly settings: PluginSettingsClient;
    };
    readonly http: {
        fetch(input: PluginNetworkFetchInput): Promise<PluginNetworkFetchResponse>;
    };
    readonly network: {
        fetch(input: PluginNetworkFetchInput): Promise<PluginNetworkFetchResponse>;
    };
    readonly exec: {
        run(input: PluginExecRunInput): Promise<PluginExecRunOutput>;
        spawn(input: PluginExecSpawnInput): Promise<PluginExecSpawnOutput>;
        kill(processId?: string): Promise<{
            killed: boolean;
            processId?: string;
        }>;
        status(processId: string): Promise<PluginExecStatusOutput>;
    };
    readonly conversation: {
        call<T = JsonValue>(operation: string, input?: JsonValue): Promise<T>;
    };
    readonly browser: {
        call<T = JsonValue>(operation: string, input?: JsonValue): Promise<T>;
    };
    readonly notify: {
        toast(input: PluginToastInput): Promise<{
            notified: boolean;
        }>;
        notify(input: PluginToastInput): Promise<{
            notified: boolean;
        }>;
    };
    readonly ui: {
        notify(input: PluginToastInput): Promise<{
            notified: boolean;
        }>;
        toast(input: PluginToastInput): Promise<{
            notified: boolean;
        }>;
    };
}
export interface VibeXPluginContext {
    readonly pluginId: string;
    readonly generation: number;
    readonly scope: EffectScope;
    readonly ui: PluginUiNamespace;
    readonly hooks: PluginHooksNamespace;
    readonly services: PluginServicesNamespace;
    readonly host: PluginHostNamespace;
    readonly worker: {
        invoke<T = JsonValue>(handler: string, input?: JsonValue): Promise<T>;
    };
    readonly events: {
        emit(event: string, payload?: unknown): void;
    };
    effect(setup: () => void | Disposer): Disposer;
    registerSlot(contribution: Omit<SlotContribution, 'pluginId'>): Disposer;
    registerCommand(contribution: Omit<CommandContribution, 'pluginId'>): Disposer;
    registerView(contribution: Omit<ViewContribution, 'pluginId' | 'title'> & {
        title?: string;
    }): Disposer;
    registerSettingsSection(contribution: Omit<SettingSectionContribution, 'pluginId'>): Disposer;
    registerSettingSection(contribution: Omit<SettingSectionContribution, 'pluginId'>): Disposer;
    registerSlashCommand(contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
        id?: string;
    }): Disposer;
    registerPromptContext(contribution: Omit<PromptContextContribution, 'pluginId'>): Disposer;
    registerProvider(contribution: Omit<ProviderContribution, 'pluginId'>): Disposer;
    registerTheme(contribution: Omit<ThemeContribution, 'pluginId'>): Disposer;
    registerInternalMessageCapture(contribution: Omit<InternalMessageCaptureContribution, 'pluginId'>): Disposer;
    registerConversationMode: PluginUiNamespace['registerConversationMode'];
    registerMarkdownRenderer: PluginUiNamespace['registerMarkdownRenderer'];
    registerOverlay: PluginUiNamespace['registerOverlay'];
    registerPanel: PluginUiNamespace['registerPanel'];
    registerKanbanView: PluginUiNamespace['registerKanbanView'];
    registerSettingsPage: PluginUiNamespace['registerSettingsPage'];
    provideService<T>(key: ServiceKey<T> | string, implementation: T): Disposer;
    injectService<T>(key: ServiceKey<T> | string): T | undefined;
    injectService(deps: ReadonlyArray<ServiceKey<unknown> | string>, effect: (resolved: Record<string, unknown>) => void | Disposer): Disposer;
    onServiceChange<T>(key: ServiceKey<T> | string, listener: () => void): Disposer;
    readonly storage: {
        readonly kv: PluginKvClient;
        readonly settings: PluginSettingsClient;
    };
    readonly network: {
        fetch(input: PluginNetworkFetchInput): Promise<PluginNetworkFetchResponse>;
    };
    readonly conversation: {
        call<T = JsonValue>(operation: string, input?: JsonValue): Promise<T>;
    };
    readonly browser: {
        call<T = JsonValue>(operation: string, input?: JsonValue): Promise<T>;
    };
    hostCall<T = JsonValue>(capability: string, operation: string, input?: JsonValue): Promise<T>;
    invokeWorker<T = JsonValue>(handler: string, input?: JsonValue): Promise<T>;
    dispose(): void;
}
export interface CreatePluginContextOptions {
    readonly pluginId: string;
    readonly generation?: number;
    readonly hostCall?: HostCallTransport;
    readonly callHost?: HostCallTransport;
    readonly invokeWorker?: WorkerInvokeTransport;
}
export declare function createPluginContext(options: CreatePluginContextOptions): VibeXPluginContext;
export interface VibeXPluginDefinition {
    readonly apiVersion: '2.0';
    readonly id?: string;
    readonly activate: (ctx: VibeXPluginContext) => void | Disposer | Promise<void | Disposer>;
    readonly deactivate?: () => void | Promise<void>;
}
export declare function defineVibeXPlugin(definition: VibeXPluginDefinition | Omit<VibeXPluginDefinition, 'apiVersion'> | VibeXPluginDefinition['activate']): VibeXPluginDefinition;
export declare const definePlugin: typeof defineVibeXPlugin;
export type VibexPluginModule = VibeXPluginDefinition;
export declare function isVibeXPluginDefinition(value: unknown): value is VibeXPluginDefinition;
