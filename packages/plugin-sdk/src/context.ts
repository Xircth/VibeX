import type { JsonValue } from './protocol.js';
import {
  type CapturedInternalMessage,
  type CommandContribution,
  commandRegistry,
  type ConversationModeContribution,
  conversationModeRegistry,
  type Disposer,
  disposePluginRegistrations,
  type InternalMessageCaptureContribution,
  internalMessageCaptureRegistry,
  type InternalPromptContributionBlock,
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
  type PromptTurnContextInput,
  type PromptTurnContributionResult,
  type ProviderContribution,
  providerRegistry,
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
  type ViewContribution,
  viewRegistry,
} from './registry.js';
import {
  EffectScope,
  serviceContainer,
  type ServiceKey,
  type WaterfallInterceptor,
} from './services.js';

export interface HostCallRequestObject {
  readonly pluginId: string;
  readonly capability: string;
  readonly operation: string;
  readonly input?: JsonValue;
}

export type HostCallTransport =
  | (<T = JsonValue>(
      pluginId: string,
      capability: string,
      operation: string,
      input?: JsonValue
    ) => Promise<T>)
  | (<T = JsonValue>(request: HostCallRequestObject) => Promise<T>);

export type WorkerInvokeTransport = <T = JsonValue>(
  pluginId: string,
  handler: string,
  input?: JsonValue
) => Promise<T>;

let defaultHostCallTransport: HostCallTransport | null = null;
let defaultWorkerInvokeTransport: WorkerInvokeTransport | null = null;

export function setDefaultHostCallTransport(
  transport: HostCallTransport | null
): void {
  defaultHostCallTransport = transport;
}

export function setDefaultWorkerInvokeTransport(
  transport: WorkerInvokeTransport | null
): void {
  defaultWorkerInvokeTransport = transport;
}

export function qualifyPluginContributionId(
  pluginId: string,
  rawId: string
): string {
  const prefix = `plugin:${pluginId}/`;
  if (rawId.startsWith(prefix)) {
    return rawId;
  }
  return `${prefix}${rawId}`;
}

export interface PluginKvClient {
  get<T = JsonValue>(key: string): Promise<T | null>;
  put<T extends JsonValue = JsonValue>(key: string, value: T): Promise<T>;
  set<T extends JsonValue = JsonValue>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  clear(): Promise<{ removed: number }>;
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
  registerView(
    contribution: Omit<ViewContribution, 'pluginId' | 'title'> & {
      title?: string;
    }
  ): Disposer;
  registerPanel(
    contribution: Omit<PanelContribution, 'pluginId'> & {
      slot?: ViewContribution['slot'];
    }
  ): Disposer;
  registerTab(
    contribution: Omit<ViewContribution, 'pluginId' | 'kind'>
  ): Disposer;
  registerKanbanView(
    contribution: Omit<KanbanViewContribution, 'pluginId'>
  ): Disposer;
  registerSettingsPage(
    contribution: Omit<SettingsPageContribution, 'pluginId'>
  ): Disposer;
  registerSettingsSection(
    contribution: Omit<SettingSectionContribution, 'pluginId'>
  ): Disposer;
  registerCommand(
    contribution: Omit<CommandContribution, 'pluginId'>
  ): Disposer;
  registerToolbarItem(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
      slot?: SlotContribution['slot'];
    }
  ): Disposer;
  registerStatusBarItem(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
      slot?: SlotContribution['slot'];
    }
  ): Disposer;
  registerStatusItem(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
      slot?: SlotContribution['slot'];
    }
  ): Disposer;
  registerRailSection(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'>
  ): Disposer;
  registerComposerAction(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
      title?: string;
      prompt?: string;
    }
  ): Disposer;
  registerComposerSlash(
    contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
      id?: string;
    }
  ): Disposer;
  registerSlashCommand(
    contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
      id?: string;
    }
  ): Disposer;
  registerConversationMode(
    contribution: Omit<ConversationModeContribution, 'pluginId'> & {
      label?: string;
      title?: string;
    }
  ): Disposer;
  registerMarkdownRenderer(
    contribution: Omit<MarkdownRendererContribution, 'pluginId'> & {
      language?: string | readonly string[];
    }
  ): Disposer;
  registerTimelineCard(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'>
  ): Disposer;
  registerOverlay(
    contribution: Omit<OverlayContribution, 'pluginId'>
  ): Disposer;
  registerContextMenu(
    contribution: Omit<SlotContribution, 'pluginId' | 'slot'> & {
      slot?: 'message.context-menu' | 'file-tree.context-menu';
      group?: string;
      action?: (context: Record<string, unknown>) => void | Promise<void>;
    }
  ): Disposer;
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
  beforeTurn(
    fn: (
      turn: BeforeTurnHookPayload
    ) =>
      | Promise<PromptTurnContributionResult | string | null | void>
      | PromptTurnContributionResult
      | string
      | null
      | void,
    order?: number
  ): Disposer;
  beforeTurn<
    TPayload = BeforeTurnHookPayload,
    TResult = PromptTurnContributionResult | string | void | TPayload,
  >(
    fn: WaterfallInterceptor<TPayload, TResult>,
    order?: number
  ): Disposer;
  afterTurn(
    fn: (event: AfterTurnHookEvent) => void | Promise<void>,
    order?: number
  ): Disposer;
  afterTurn<TPayload = AfterTurnHookEvent, TResult = TPayload>(
    fn: WaterfallInterceptor<TPayload, TResult>,
    order?: number
  ): Disposer;
  onRuntimeEvent(
    fn: (event: RuntimeEventHookPayload) => void | Promise<void>,
    order?: number
  ): Disposer;
  onRuntimeEvent<TPayload = RuntimeEventHookPayload, TResult = TPayload>(
    fn: WaterfallInterceptor<TPayload, TResult>,
    order?: number
  ): Disposer;
  captureInternalMessage(
    contribution: Omit<InternalMessageCaptureContribution, 'pluginId' | 'id'> & {
      id?: string;
    }
  ): Disposer;
  captureInternalMessage(
    channel: string,
    onCapture: (message: CapturedInternalMessage) => void | Promise<void>,
    options?: {
      id?: string;
      nonce?: string;
      validate?: (payload: unknown) => boolean;
      order?: number;
    }
  ): Disposer;
  intercept<TPayload = unknown, TResult = unknown>(
    hookName: string,
    fn: WaterfallInterceptor<TPayload, TResult>,
    order?: number
  ): Disposer;
}

export interface PluginServicesNamespace {
  provide<T>(key: ServiceKey<T> | string, implementation: T): Disposer;
  get<T>(key: ServiceKey<T> | string): T | undefined;
  inject<T>(key: ServiceKey<T> | string): T | undefined;
  inject(
    deps: ReadonlyArray<ServiceKey<unknown> | string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effect: (resolved: any) => void | Disposer
  ): Disposer;
  require<T>(key: ServiceKey<T> | string): T;
  intercept<TPayload = unknown, TResult = unknown>(
    hookName: string,
    fn:
      | WaterfallInterceptor<TPayload, TResult>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | ((previousService: any) => any),
    order?: number
  ): Disposer;
  onChange<T>(key: ServiceKey<T> | string, listener: () => void): Disposer;
}

export interface PluginHostNamespace {
  call<T = JsonValue>(
    capability: string,
    operation: string,
    input?: JsonValue
  ): Promise<T>;
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
    kill(processId?: string): Promise<{ killed: boolean; processId?: string }>;
    status(processId: string): Promise<PluginExecStatusOutput>;
  };
  readonly conversation: {
    call<T = JsonValue>(operation: string, input?: JsonValue): Promise<T>;
  };
  readonly browser: {
    call<T = JsonValue>(operation: string, input?: JsonValue): Promise<T>;
  };
  readonly notify: {
    toast(input: PluginToastInput): Promise<{ notified: boolean }>;
    notify(input: PluginToastInput): Promise<{ notified: boolean }>;
  };
  readonly ui: {
    notify(input: PluginToastInput): Promise<{ notified: boolean }>;
    toast(input: PluginToastInput): Promise<{ notified: boolean }>;
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
  registerCommand(
    contribution: Omit<CommandContribution, 'pluginId'>
  ): Disposer;
  registerView(
    contribution: Omit<ViewContribution, 'pluginId' | 'title'> & {
      title?: string;
    }
  ): Disposer;
  registerSettingsSection(
    contribution: Omit<SettingSectionContribution, 'pluginId'>
  ): Disposer;
  registerSettingSection(
    contribution: Omit<SettingSectionContribution, 'pluginId'>
  ): Disposer;
  registerSlashCommand(
    contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
      id?: string;
    }
  ): Disposer;
  registerPromptContext(
    contribution: Omit<PromptContextContribution, 'pluginId'>
  ): Disposer;
  registerProvider(
    contribution: Omit<ProviderContribution, 'pluginId'>
  ): Disposer;
  registerTheme(contribution: Omit<ThemeContribution, 'pluginId'>): Disposer;
  registerInternalMessageCapture(
    contribution: Omit<InternalMessageCaptureContribution, 'pluginId'>
  ): Disposer;
  registerConversationMode: PluginUiNamespace['registerConversationMode'];
  registerMarkdownRenderer: PluginUiNamespace['registerMarkdownRenderer'];
  registerOverlay: PluginUiNamespace['registerOverlay'];
  registerPanel: PluginUiNamespace['registerPanel'];
  registerKanbanView: PluginUiNamespace['registerKanbanView'];
  registerSettingsPage: PluginUiNamespace['registerSettingsPage'];

  provideService<T>(
    key: ServiceKey<T> | string,
    implementation: T
  ): Disposer;
  injectService<T>(key: ServiceKey<T> | string): T | undefined;
  injectService(
    deps: ReadonlyArray<ServiceKey<unknown> | string>,
    effect: (resolved: Record<string, unknown>) => void | Disposer
  ): Disposer;
  onServiceChange<T>(
    key: ServiceKey<T> | string,
    listener: () => void
  ): Disposer;

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

  hostCall<T = JsonValue>(
    capability: string,
    operation: string,
    input?: JsonValue
  ): Promise<T>;
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

export function createPluginContext(
  options: CreatePluginContextOptions
): VibeXPluginContext {
  const { pluginId, generation = 1 } = options;
  const scope = new EffectScope();

  const hostCall = async <T = JsonValue>(
    capability: string,
    operation: string,
    input?: JsonValue
  ): Promise<T> => {
    const transport =
      options.hostCall ?? options.callHost ?? defaultHostCallTransport;
    if (!transport) {
      throw new Error(
        `HostCallTransport is not configured for plugin "${pluginId}" (${capability}.${operation})`
      );
    }
    if (transport.length === 1) {
      return await (
        transport as <R = JsonValue>(req: HostCallRequestObject) => Promise<R>
      )<T>({
        pluginId,
        capability,
        operation,
        input: input ?? null,
      });
    }
    return await (
      transport as <R = JsonValue>(
        p: string,
        c: string,
        o: string,
        i?: JsonValue
      ) => Promise<R>
    )<T>(pluginId, capability, operation, input ?? null);
  };

  const invokeWorker = async <T = JsonValue>(
    handler: string,
    input?: JsonValue
  ): Promise<T> => {
    const transport = options.invokeWorker ?? defaultWorkerInvokeTransport;
    if (!transport) {
      throw new Error(
        `WorkerInvokeTransport is not configured for plugin "${pluginId}" (${handler})`
      );
    }
    return await transport<T>(pluginId, handler, input ?? null);
  };

  const scopeStack: EffectScope[] = [scope];
  const currentScope = (): EffectScope =>
    scopeStack[scopeStack.length - 1] ?? scope;
  const track = (disposer: Disposer): Disposer =>
    currentScope().addDisposer(disposer);

  const registerSlot = (
    contribution: Omit<SlotContribution, 'pluginId'>
  ): Disposer =>
    track(slotRegistry.register({ ...contribution, pluginId }, pluginId));

  const registerCommand = (
    contribution: Omit<CommandContribution, 'pluginId'>
  ): Disposer =>
    track(commandRegistry.register({ ...contribution, pluginId }, pluginId));

  const registerView = (
    contribution: Omit<ViewContribution, 'pluginId' | 'title'> & {
      title?: string;
    }
  ): Disposer =>
    track(
      viewRegistry.register(
        {
          ...contribution,
          title: contribution.title ?? contribution.id,
          pluginId,
        },
        pluginId
      )
    );

  const registerSettingsSection = (
    contribution: Omit<SettingSectionContribution, 'pluginId'>
  ): Disposer =>
    track(settingRegistry.register({ ...contribution, pluginId }, pluginId));

  const registerSlashCommand = (
    contribution: Omit<SlashCommandContribution, 'pluginId' | 'id'> & {
      id?: string;
    }
  ): Disposer =>
    track(
      slashCommandRegistry.register(
        {
          ...contribution,
          id: contribution.id ?? contribution.name,
          pluginId,
        },
        pluginId
      )
    );

  const registerPromptContext = (
    contribution: Omit<PromptContextContribution, 'pluginId'>
  ): Disposer =>
    track(
      promptContextRegistry.register({ ...contribution, pluginId }, pluginId)
    );

  const registerProvider = (
    contribution: Omit<ProviderContribution, 'pluginId'>
  ): Disposer =>
    track(providerRegistry.register({ ...contribution, pluginId }, pluginId));

  const registerTheme = (
    contribution: Omit<ThemeContribution, 'pluginId'>
  ): Disposer =>
    track(themeRegistry.register({ ...contribution, pluginId }, pluginId));

  const registerInternalMessageCapture = (
    contribution: Omit<InternalMessageCaptureContribution, 'pluginId'>
  ): Disposer =>
    track(
      internalMessageCaptureRegistry.register(
        { ...contribution, pluginId },
        pluginId
      )
    );

  const kvClient: PluginKvClient = {
    async get<T = JsonValue>(key: string): Promise<T | null> {
      const result = await hostCall<T | null>('storage', 'kv.get', { key });
      return result ?? null;
    },
    async put<T extends JsonValue = JsonValue>(
      key: string,
      value: T
    ): Promise<T> {
      return await hostCall<T>('storage', 'kv.put', { key, value });
    },
    async set<T extends JsonValue = JsonValue>(
      key: string,
      value: T
    ): Promise<T> {
      return await hostCall<T>('storage', 'kv.put', { key, value });
    },
    async delete(key: string): Promise<void> {
      await hostCall('storage', 'kv.delete', { key });
    },
    async list(prefix?: string): Promise<string[]> {
      return await hostCall<string[]>(
        'storage',
        'kv.list',
        prefix ? { prefix } : {}
      );
    },
    async clear(): Promise<{ removed: number }> {
      return await hostCall<{ removed: number }>('storage', 'kv.clear', {});
    },
  };

  const settingsClient: PluginSettingsClient = {
    async get<T = JsonValue>(): Promise<T> {
      return await hostCall<T>('storage', 'settings.get', {});
    },
    async put<T extends JsonValue = JsonValue>(value: T): Promise<T> {
      return await hostCall<T>('storage', 'settings.put', value);
    },
    async set<T extends JsonValue = JsonValue>(value: T): Promise<T> {
      return await hostCall<T>('storage', 'settings.put', value);
    },
  };

  const networkClient = {
    async fetch(
      input: PluginNetworkFetchInput
    ): Promise<PluginNetworkFetchResponse> {
      return await hostCall<PluginNetworkFetchResponse>('network', 'fetch', {
        url: input.url,
        method: input.method ?? 'GET',
        headers: (input.headers ?? {}) as unknown as JsonValue,
        body: input.body ?? null,
        timeoutMs: input.timeoutMs ?? 30_000,
      });
    },
  };

  const conversationClient = {
    async call<T = JsonValue>(
      operation: string,
      input?: JsonValue
    ): Promise<T> {
      return await hostCall<T>('conversation', operation, input ?? {});
    },
  };

  const browserClient = {
    async call<T = JsonValue>(
      operation: string,
      input?: JsonValue
    ): Promise<T> {
      return await hostCall<T>('browser', operation, input ?? {});
    },
  };

  const execClient = {
    async run(input: PluginExecRunInput): Promise<PluginExecRunOutput> {
      return await hostCall<PluginExecRunOutput>('exec', 'run', {
        program: input.program,
        args: (input.args ?? []) as unknown as JsonValue,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env as unknown as JsonValue } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.timeoutMs !== undefined
          ? { timeoutMs: input.timeoutMs }
          : {}),
      });
    },
    async spawn(input: PluginExecSpawnInput): Promise<PluginExecSpawnOutput> {
      return await hostCall<PluginExecSpawnOutput>('exec', 'spawn', {
        program: input.program,
        args: (input.args ?? []) as unknown as JsonValue,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env as unknown as JsonValue } : {}),
      });
    },
    async kill(
      processId?: string
    ): Promise<{ killed: boolean; processId?: string }> {
      return await hostCall<{ killed: boolean; processId?: string }>(
        'exec',
        'kill',
        processId ? { processId } : {}
      );
    },
    async status(processId: string): Promise<PluginExecStatusOutput> {
      return await hostCall<PluginExecStatusOutput>('exec', 'status', {
        processId,
      });
    },
  };

  const notifyClient = {
    async toast(input: PluginToastInput): Promise<{ notified: boolean }> {
      return await hostCall<{ notified: boolean }>('app', 'notify.toast', {
        title: input.title,
        message: input.message ?? '',
        variant: input.variant ?? 'info',
        durationMs: input.durationMs ?? 4000,
      });
    },
    async notify(input: PluginToastInput): Promise<{ notified: boolean }> {
      return await notifyClient.toast(input);
    },
  };

  const ui: PluginUiNamespace = {
    registerSlot,
    registerView,
    registerPanel(contribution) {
      const disposePanel = track(
        panelRegistry.register({ ...contribution, pluginId }, pluginId)
      );
      const disposeView = registerView({
        id: contribution.id,
        title: contribution.title,
        icon: contribution.icon,
        slot: contribution.slot,
        component: contribution.component,
        order: contribution.order,
        kind: 'panel',
      });
      return () => {
        disposePanel();
        disposeView();
      };
    },
    registerTab(contribution) {
      return registerView({ ...contribution, kind: 'tab' });
    },
    registerKanbanView(contribution) {
      const disposeKanban = track(
        kanbanViewRegistry.register({ ...contribution, pluginId }, pluginId)
      );
      const disposeView = registerView({
        id: contribution.id,
        title: contribution.title,
        icon: contribution.icon,
        component: contribution.component,
        order: contribution.order,
        kind: 'kanban',
      });
      return () => {
        disposeKanban();
        disposeView();
      };
    },
    registerSettingsPage(contribution) {
      const disposePage = track(
        settingsPageRegistry.register({ ...contribution, pluginId }, pluginId)
      );
      const disposeView = registerView({
        id: contribution.id,
        title: contribution.title,
        icon: contribution.icon,
        component: contribution.component,
        order: contribution.order,
        kind: 'settings',
      });
      return () => {
        disposePage();
        disposeView();
      };
    },
    registerSettingsSection,
    registerCommand,
    registerToolbarItem(contribution) {
      return registerSlot({
        ...contribution,
        slot: contribution.slot ?? 'toolbar.actions',
      });
    },
    registerStatusBarItem(contribution) {
      return registerSlot({
        ...contribution,
        slot: contribution.slot ?? 'statusbar.items',
      });
    },
    registerStatusItem(contribution) {
      return registerSlot({
        ...contribution,
        slot: contribution.slot ?? 'statusbar.items',
      });
    },
    registerRailSection(contribution) {
      return registerSlot({
        ...contribution,
        slot: 'rail.sections',
      });
    },
    registerComposerAction(contribution) {
      return registerSlot({
        ...contribution,
        label: contribution.label ?? contribution.title,
        slot: 'composer.actions',
      });
    },
    registerComposerSlash: registerSlashCommand,
    registerSlashCommand,
    registerConversationMode(contribution) {
      const normalizedLabel =
        contribution.label ?? contribution.title ?? contribution.id;
      const disposeMode = track(
        conversationModeRegistry.register(
          {
            ...contribution,
            label: normalizedLabel,
            takeover:
              contribution.takeover ??
              Boolean(contribution.component || contribution.render),
            pluginId,
          },
          pluginId
        )
      );
      const disposeSlot = registerSlot({
        id: contribution.id,
        label: normalizedLabel,
        tooltip: contribution.description,
        icon: contribution.icon,
        component: contribution.component,
        render: contribution.render,
        onActivate: contribution.onActivate,
        order: contribution.order,
        slot: 'composer.mode',
      });
      return () => {
        disposeMode();
        disposeSlot();
      };
    },
    registerMarkdownRenderer(contribution) {
      const language = contribution.language ?? contribution.id;
      const disposeMarkdown = track(
        markdownRegistry.register(
          {
            ...contribution,
            language,
            pluginId,
          },
          pluginId
        )
      );
      const disposeSlot = registerSlot({
        id: contribution.id,
        label: Array.isArray(language) ? language.join(',') : String(language),
        component: contribution.component as SlotContribution['component'],
        render: contribution.render as SlotContribution['render'],
        order: contribution.order,
        slot: 'markdown.codeblock',
      });
      return () => {
        disposeMarkdown();
        disposeSlot();
      };
    },
    registerTimelineCard(contribution) {
      return registerSlot({
        ...contribution,
        slot: 'timeline.card',
      });
    },
    registerOverlay(contribution) {
      const disposeOverlay = track(
        overlayRegistry.register({ ...contribution, pluginId }, pluginId)
      );
      const disposeSlot = registerSlot({
        id: contribution.id,
        label: contribution.title,
        component: contribution.component,
        render: contribution.render,
        when: contribution.when,
        order: contribution.order,
        slot: 'global.overlay',
      });
      return () => {
        disposeOverlay();
        disposeSlot();
      };
    },
    registerContextMenu(contribution) {
      const action = contribution.action;
      return registerSlot({
        ...contribution,
        onActivate:
          contribution.onActivate ??
          (action ? (ctx) => action(ctx ?? {}) : undefined),
        slot: contribution.slot ?? 'message.context-menu',
      });
    },
  };

  let hookCounter = 0;

  const hooks: PluginHooksNamespace = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeTurn(fn: any, order = 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped: WaterfallInterceptor<any, any> = async (turn, next) => {
        let nextCalled = false;
        let currentTurn = turn;
        const callNext = async (nextPayload: unknown) => {
          nextCalled = true;
          currentTurn = await next(nextPayload ?? turn);
          return currentTurn;
        };
        const result = await (fn as WaterfallInterceptor<unknown, unknown>)(
          turn,
          callNext
        );
        if (!nextCalled) {
          currentTurn = await next(turn);
        }
        if (
          typeof result === 'string' &&
          result.trim() &&
          currentTurn &&
          typeof currentTurn === 'object' &&
          Array.isArray(currentTurn.internalPromptContributions)
        ) {
          currentTurn.internalPromptContributions.push({
            pluginId,
            label: null,
            content: result.trim(),
            priority: order,
          });
          return currentTurn;
        }
        if (
          result &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          ('content' in result ||
            'hiddenContext' in result ||
            'appendPrompt' in result ||
            'prependSystemPrompt' in result ||
            'blocks' in result ||
            ('text' in result && !('internalPromptContributions' in result)))
        ) {
          const r = result as PromptTurnContributionResult;
          if (
            typeof r.text === 'string' &&
            r.text.trim() &&
            currentTurn &&
            typeof currentTurn === 'object'
          ) {
            currentTurn = { ...currentTurn, text: r.text };
          }
          const content =
            r.content?.trim() ||
            r.hiddenContext?.trim() ||
            r.appendPrompt?.trim() ||
            r.prependSystemPrompt?.trim();
          if (
            content &&
            currentTurn &&
            typeof currentTurn === 'object' &&
            Array.isArray(currentTurn.internalPromptContributions)
          ) {
            currentTurn.internalPromptContributions.push({
              pluginId,
              label: r.label ?? null,
              content,
              priority: r.priority ?? order,
            });
          }
          if (
            Array.isArray(r.blocks) &&
            currentTurn &&
            typeof currentTurn === 'object' &&
            Array.isArray(currentTurn.internalPromptContributions)
          ) {
            for (const block of r.blocks) {
              const blockContent = block?.content?.trim();
              if (!blockContent) continue;
              currentTurn.internalPromptContributions.push({
                pluginId,
                label: block.label ?? null,
                content: blockContent,
                priority: block.priority ?? r.priority ?? (order || 100),
              });
            }
          }
          return currentTurn;
        }
        return result !== undefined ? result : currentTurn;
      };
      return track(
        serviceContainer.intercept(
          'conversation.beforeTurn',
          wrapped,
          order,
          pluginId
        )
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterTurn(fn: any, order = 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped: WaterfallInterceptor<any, any> = async (event, next) => {
        let nextCalled = false;
        let out = event;
        const callNext = async (nextPayload: unknown) => {
          nextCalled = true;
          out = await next(nextPayload ?? event);
          return out;
        };
        const res = await (fn as WaterfallInterceptor<unknown, unknown>)(
          event,
          callNext
        );
        if (!nextCalled) {
          out = await next(event);
        }
        return res !== undefined ? res : out;
      };
      return track(
        serviceContainer.intercept(
          'conversation.afterTurn',
          wrapped,
          order,
          pluginId
        )
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onRuntimeEvent(fn: any, order = 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped: WaterfallInterceptor<any, any> = async (event, next) => {
        let nextCalled = false;
        let out = event;
        const callNext = async (nextPayload: unknown) => {
          nextCalled = true;
          out = await next(nextPayload ?? event);
          return out;
        };
        const res = await (fn as WaterfallInterceptor<unknown, unknown>)(
          event,
          callNext
        );
        if (!nextCalled) {
          out = await next(event);
        }
        return res !== undefined ? res : out;
      };
      return track(
        serviceContainer.intercept('runtime.event', wrapped, order, pluginId)
      );
    },
    captureInternalMessage(
      channelOrContribution:
        | string
        | (Omit<InternalMessageCaptureContribution, 'pluginId' | 'id'> & {
            id?: string;
          }),
      onCapture?: (message: CapturedInternalMessage) => void | Promise<void>,
      options?: {
        id?: string;
        nonce?: string;
        validate?: (payload: unknown) => boolean;
        order?: number;
      }
    ): Disposer {
      hookCounter += 1;
      if (typeof channelOrContribution === 'string') {
        if (!onCapture) {
          throw new Error(
            'captureInternalMessage(channel, onCapture) requires an onCapture handler'
          );
        }
        return registerInternalMessageCapture({
          id:
            options?.id ??
            `${pluginId}:internal:${channelOrContribution}:${hookCounter}`,
          channel: channelOrContribution,
          nonce: options?.nonce,
          validate: options?.validate,
          order: options?.order,
          onCapture,
        });
      }
      return registerInternalMessageCapture({
        ...channelOrContribution,
        id:
          channelOrContribution.id ??
          `${pluginId}:internal:${channelOrContribution.channel}:${hookCounter}`,
      });
    },
    intercept(hookName, fn, order = 0) {
      return track(
        serviceContainer.intercept(hookName, fn, order, pluginId)
      );
    },
  };

  function injectImpl<T>(key: ServiceKey<T> | string): T | undefined;
  function injectImpl(
    deps: ReadonlyArray<ServiceKey<unknown> | string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effect: (resolved: any) => void | Disposer
  ): Disposer;
  function injectImpl<T>(
    keyOrDeps:
      | ServiceKey<T>
      | string
      | ReadonlyArray<ServiceKey<unknown> | string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effect?: (resolved: any) => void | Disposer
  ): T | undefined | Disposer {
    if (Array.isArray(keyOrDeps)) {
      if (typeof effect !== 'function') {
        throw new Error(
          'ctx.services.inject(deps, effect) requires an effect callback'
        );
      }
      const wrappedEffect = (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolved: Record<string, any> & Iterable<any>
      ): Disposer => {
        const subScope = new EffectScope();
        scopeStack.push(subScope);
        try {
          const maybeCleanup = effect(resolved);
          if (typeof maybeCleanup === 'function') {
            subScope.addDisposer(maybeCleanup);
          }
        } finally {
          scopeStack.pop();
        }
        return () => {
          subScope.dispose();
        };
      };
      return track(serviceContainer.inject(keyOrDeps, wrappedEffect, pluginId));
    }
    return serviceContainer.inject(keyOrDeps as ServiceKey<T> | string);
  }

  const services: PluginServicesNamespace = {
    provide<T>(key: ServiceKey<T> | string, implementation: T): Disposer {
      return track(serviceContainer.provide(key, implementation, pluginId));
    },
    get<T>(key: ServiceKey<T> | string): T | undefined {
      return serviceContainer.get(key);
    },
    inject: injectImpl,
    require<T>(key: ServiceKey<T> | string): T {
      return serviceContainer.require(key);
    },
    intercept<TPayload = unknown, TResult = unknown>(
      hookName: string,
      fn:
        | WaterfallInterceptor<TPayload, TResult>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        | ((previousService: any) => any),
      order = 0
    ): Disposer {
      return track(
        serviceContainer.intercept(hookName, fn, order, pluginId)
      );
    },
    onChange<T>(key: ServiceKey<T> | string, listener: () => void): Disposer {
      return track(serviceContainer.onServiceChange(key, listener));
    },
  };

  const host: PluginHostNamespace = {
    call: hostCall,
    storage: {
      kv: kvClient,
      settings: settingsClient,
    },
    http: networkClient,
    network: networkClient,
    exec: execClient,
    conversation: conversationClient,
    browser: browserClient,
    notify: notifyClient,
    ui: notifyClient,
  };

  return {
    pluginId,
    generation,
    scope,

    ui,
    hooks,
    services,
    host,
    worker: {
      invoke: invokeWorker,
    },
    events: {
      emit() {
        // No-op default event emitter for in-process notifications
      },
    },

    effect(setup) {
      return currentScope().effect(setup);
    },

    registerSlot,
    registerCommand,
    registerView,
    registerSettingsSection,
    registerSettingSection: registerSettingsSection,
    registerSlashCommand,
    registerPromptContext,
    registerProvider,
    registerTheme,
    registerInternalMessageCapture,
    registerConversationMode: ui.registerConversationMode,
    registerMarkdownRenderer: ui.registerMarkdownRenderer,
    registerOverlay: ui.registerOverlay,
    registerPanel: ui.registerPanel,
    registerKanbanView: ui.registerKanbanView,
    registerSettingsPage: ui.registerSettingsPage,

    provideService: services.provide,
    injectService: injectImpl,
    onServiceChange: services.onChange,

    storage: host.storage,
    network: host.network,
    conversation: host.conversation,
    browser: host.browser,

    hostCall,
    invokeWorker,

    dispose() {
      scope.dispose();
      disposePluginRegistrations(pluginId);
      serviceContainer.disposeByPlugin(pluginId);
    },
  };
}

export interface VibeXPluginDefinition {
  readonly apiVersion: '2.0';
  readonly id?: string;
  readonly activate: (
    ctx: VibeXPluginContext
  ) => void | Disposer | Promise<void | Disposer>;
  readonly deactivate?: () => void | Promise<void>;
}

export function defineVibeXPlugin(
  definition:
    | VibeXPluginDefinition
    | Omit<VibeXPluginDefinition, 'apiVersion'>
    | VibeXPluginDefinition['activate']
): VibeXPluginDefinition {
  if (typeof definition === 'function') {
    return {
      apiVersion: '2.0',
      activate: definition,
    };
  }
  return {
    ...definition,
    apiVersion: '2.0',
  };
}

export const definePlugin = defineVibeXPlugin;

export type VibexPluginModule = VibeXPluginDefinition;

export function isVibeXPluginDefinition(
  value: unknown
): value is VibeXPluginDefinition {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<VibeXPluginDefinition>;
  return (
    candidate.apiVersion === '2.0' && typeof candidate.activate === 'function'
  );
}
