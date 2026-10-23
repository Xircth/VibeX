import type { JsonValue, PluginContext } from './protocol.js';
import {
  createPluginContext,
  type VibeXPluginContext,
  type VibeXPluginDefinition,
} from './context.js';
import {
  type CommandContribution,
  commandRegistry,
  type ConversationModeContribution,
  conversationModeRegistry,
  type Disposer,
  type KanbanViewContribution,
  kanbanViewRegistry,
  type MarkdownRendererContribution,
  markdownRegistry,
  type OverlayContribution,
  overlayRegistry,
  type PanelContribution,
  panelRegistry,
  type SettingSectionContribution,
  settingRegistry,
  type SettingsPageContribution,
  settingsPageRegistry,
  type SlashCommandContribution,
  slashCommandRegistry,
  type SlotContribution,
  slotRegistry,
  type ViewContribution,
  viewRegistry,
} from './registry.js';
import {
  activatePluginWorker,
  type ActivatedPluginWorker,
  type PluginHostClient,
  type PluginWorkerDefinition,
  PluginSdkError,
} from './worker.js';

export interface WorkerHarness extends ActivatedPluginWorker {
  readonly hostCalls: ReadonlyArray<{
    capability: string;
    operation: string;
    input: JsonValue;
  }>;
}

export async function createWorkerHarness(
  definition: PluginWorkerDefinition,
  options: {
    context?: Partial<PluginContext>;
    host?: PluginHostClient;
  } = {}
): Promise<WorkerHarness> {
  const hostCalls: Array<{
    capability: string;
    operation: string;
    input: JsonValue;
  }> = [];
  const host = options.host ?? createMemoryHostClient(hostCalls);
  const worker = await activatePluginWorker(definition, {
    context: {
      pluginId: options.context?.pluginId ?? 'dev.vibex.test',
      pluginVersion: options.context?.pluginVersion ?? '0.0.0-test',
      generation: options.context?.generation ?? 1,
      packageClass: options.context?.packageClass ?? 'full-trust',
      grantedCapabilities: options.context?.grantedCapabilities ?? ['*'],
    },
    host,
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
  return Object.assign(worker, { hostCalls });
}

export interface GenerationHarness {
  readonly generation: number;
  readonly handlers: readonly string[];
  invoke(handler: string, input: JsonValue): Promise<JsonValue>;
  activateCandidate(definition: PluginWorkerDefinition): Promise<number>;
  dispose(): Promise<void>;
}

export async function createGenerationHarness(
  definition: PluginWorkerDefinition,
  options: {
    context?: Partial<PluginContext>;
    host?: PluginHostClient;
    requiredHandlers?: readonly string[];
  } = {}
): Promise<GenerationHarness> {
  let generation = options.context?.generation ?? 1;
  let active = await createWorkerHarness(definition, {
    context: { ...options.context, generation },
    host: options.host,
  });
  assertRequiredHandlers(active, options.requiredHandlers);

  return {
    get generation() {
      return generation;
    },
    get handlers() {
      return active.handlers;
    },
    invoke(handler, input) {
      return active.invoke(handler, input);
    },
    async activateCandidate(candidateDefinition) {
      const candidateGeneration = generation + 1;
      const candidate = await createWorkerHarness(candidateDefinition, {
        context: { ...options.context, generation: candidateGeneration },
        host: options.host,
      });
      try {
        assertRequiredHandlers(candidate, options.requiredHandlers);
      } catch (error) {
        await candidate.dispose();
        throw error;
      }
      const previous = active;
      active = candidate;
      generation = candidateGeneration;
      await previous.dispose();
      return generation;
    },
    async dispose() {
      await active.dispose();
    },
  };
}

function assertRequiredHandlers(
  worker: ActivatedPluginWorker,
  requiredHandlers: readonly string[] | undefined
) {
  for (const handler of requiredHandlers ?? []) {
    if (!worker.handlers.includes(handler)) {
      throw new PluginSdkError(
        'required_handler_missing',
        `Required handler ${handler} is not registered`
      );
    }
  }
}

/**
 * In-memory Host: implements storage, secrets, log, artifact, network, exec, notify, and doctor.
 * Every other catalog operation fails with capability_unimplemented.
 */
function createMemoryHostClient(
  hostCalls: Array<{ capability: string; operation: string; input: JsonValue }>
): PluginHostClient {
  const settings: Record<string, JsonValue> = {};
  const kv = new Map<string, JsonValue>();
  const secrets = new Map<string, string>();
  let artifact = {
    name: 'memory.txt',
    content: '',
    revision: 'sha256:test-0',
  };
  return {
    async call<T extends JsonValue = JsonValue>(
      capability: string,
      operation: string,
      input: JsonValue = null
    ): Promise<T> {
      hostCalls.push({ capability, operation, input });
      const key = `${capability}.${operation}`;
      switch (key) {
        case 'storage.settings.get':
          return { ...settings } as T;
        case 'storage.settings.put':
          Object.assign(
            settings,
            (input as { value?: Record<string, JsonValue> })?.value ?? input
          );
          return { ...settings } as T;
        case 'storage.kv.get':
          return (kv.get(String((input as { key?: string })?.key)) ??
            null) as T;
        case 'storage.kv.put': {
          const rec = input as { key?: string; value?: JsonValue };
          if (rec.key) kv.set(rec.key, rec.value ?? null);
          return (rec.value ?? null) as T;
        }
        case 'storage.kv.delete':
          kv.delete(String((input as { key?: string })?.key));
          return null as T;
        case 'storage.kv.list':
          return [...kv.keys()] as T;
        case 'storage.kv.clear': {
          const removed = kv.size;
          kv.clear();
          return { removed } as unknown as T;
        }
        case 'network.fetch':
          return {
            status: 200,
            ok: true,
            statusText: 'OK',
            headers: {},
            body: '',
            bodyText: '',
          } as unknown as T;
        case 'exec.run':
          return {
            exitCode: 0,
            stdout: '',
            stderr: '',
            success: true,
          } as unknown as T;
        case 'exec.spawn':
          return {
            processId: 'proc-test-1',
            pid: 12345,
          } as unknown as T;
        case 'exec.kill':
          return {
            killed: true,
            processId: (input as { processId?: string })?.processId,
          } as unknown as T;
        case 'exec.status':
          return {
            processId: String(
              (input as { processId?: string })?.processId ?? 'proc-test-1'
            ),
            running: false,
            exitCode: 0,
          } as unknown as T;
        case 'app.notify.toast':
          return { notified: true } as unknown as T;
        case 'storage.database.execute':
        case 'storage.database.query':
          return { rows: [], changes: 0 } as unknown as T;
        case 'secrets.get': {
          const name = String((input as { name?: string })?.name ?? '');
          const value = secrets.get(name);
          return (
            value === undefined
              ? { present: false }
              : { present: true, value }
          ) as unknown as T;
        }
        case 'secrets.put': {
          const rec = input as { name?: string; value?: string };
          if (rec.name) secrets.set(rec.name, rec.value ?? '');
          return { present: true } as unknown as T;
        }
        case 'secrets.delete':
          secrets.delete(String((input as { name?: string })?.name ?? ''));
          return { present: false } as unknown as T;
        case 'log.debug':
        case 'log.info':
        case 'log.warn':
        case 'log.error':
          return {} as T;
        case 'artifact.readText':
          return { ...artifact } as unknown as T;
        case 'artifact.writeText': {
          const rec = input as { content?: string; expectedRevision?: string };
          if (
            rec.expectedRevision &&
            rec.expectedRevision !== artifact.revision
          ) {
            throw new PluginSdkError(
              'artifact_revision_conflict',
              'The artifact changed outside this editor'
            );
          }
          artifact = {
            ...artifact,
            content: rec.content ?? '',
            revision: `sha256:test-${Date.now()}`,
          };
          return { revision: artifact.revision } as unknown as T;
        }
        case 'plugin.self.doctor':
          return { diagnostics: [], recentCrashes: [] } as unknown as T;
        default:
          throw new PluginSdkError(
            'capability_unimplemented',
            `${key} is not implemented by the in-memory harness`
          );
      }
    },
  };
}

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
  activate(
    plugin?:
      | VibeXPluginDefinition
      | ((ctx: VibeXPluginContext) => void | Disposer | Promise<void | Disposer>)
  ): Promise<void>;
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

export type PluginTestTarget =
  | VibeXPluginDefinition
  | ((ctx: VibeXPluginContext) => void | Disposer | Promise<void | Disposer>);

export interface PluginTestHarnessConfig {
  pluginId?: string;
  generation?: number;
  host?: PluginHostClient;
  plugin?: PluginTestTarget;
}

export type PluginTestHarnessOptions =
  | PluginTestHarnessConfig
  | PluginTestTarget;

function isDirectPluginTarget(
  value: PluginTestHarnessOptions
): value is PluginTestTarget {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' &&
      value !== null &&
      'activate' in value &&
      typeof value.activate === 'function')
  );
}

export function createPluginTestHarness(
  optionsOrPlugin: PluginTestHarnessOptions = {}
): PluginTestHarness {
  const direct = isDirectPluginTarget(optionsOrPlugin);
  const defaultPlugin: PluginTestTarget | undefined = direct
    ? optionsOrPlugin
    : optionsOrPlugin.plugin;
  const pluginId = direct
    ? typeof optionsOrPlugin === 'object' && optionsOrPlugin.id
      ? optionsOrPlugin.id
      : 'dev.vibex.test'
    : (optionsOrPlugin.pluginId ?? 'dev.vibex.test');
  const generation = direct ? 1 : (optionsOrPlugin.generation ?? 1);
  const hostCalls: Array<{
    capability: string;
    operation: string;
    input: JsonValue;
  }> = [];
  const memoryHost =
    (!direct ? optionsOrPlugin.host : undefined) ??
    createMemoryHostClient(hostCalls);
  const ctx = createPluginContext({
    pluginId,
    generation,
    callHost: async <T = JsonValue>(
      _pid: string,
      capability: string,
      operation: string,
      input?: JsonValue
    ): Promise<T> => {
      return (await memoryHost.call<JsonValue>(
        capability,
        operation,
        input ?? null
      )) as T;
    },
  });
  let deactivateFn: (() => void | Promise<void>) | undefined;
  let customDisposer: Disposer | undefined;

  return {
    pluginId,
    ctx,
    hostCalls,
    registries: {
      slot: slotRegistry,
      command: commandRegistry,
      view: viewRegistry,
      panel: panelRegistry,
      kanbanView: kanbanViewRegistry,
      settingsPage: settingsPageRegistry,
      setting: settingRegistry,
      slashCommand: slashCommandRegistry,
      markdown: markdownRegistry,
      conversationMode: conversationModeRegistry,
      overlay: overlayRegistry,
    },
    async activate(pluginArg) {
      const target = pluginArg ?? defaultPlugin;
      if (!target) {
        throw new Error(
          'createPluginTestHarness.activate() requires a plugin definition or activate function'
        );
      }
      const fn = typeof target === 'function' ? target : target.activate;
      deactivateFn =
        typeof target === 'object' && target !== null
          ? target.deactivate
          : undefined;
      const result = await fn(ctx);
      if (typeof result === 'function') {
        customDisposer = result;
      }
    },
    getSlots(slot?: string) {
      const all = slot ? slotRegistry.getBySlot(slot) : slotRegistry.getAll();
      return all.filter((item) => item.pluginId === pluginId);
    },
    getCommands() {
      return commandRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getViews() {
      return viewRegistry.getAll().filter((item) => item.pluginId === pluginId);
    },
    getPanels() {
      return panelRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getKanbanViews() {
      return kanbanViewRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getSettingsPages() {
      return settingsPageRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getSettingsSections() {
      return settingRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getSlashCommands() {
      return slashCommandRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getMarkdownRenderers() {
      return markdownRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getConversationModes() {
      return conversationModeRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    getOverlays() {
      return overlayRegistry
        .getAll()
        .filter((item) => item.pluginId === pluginId);
    },
    async dispose() {
      customDisposer?.();
      customDisposer = undefined;
      await deactivateFn?.();
      deactivateFn = undefined;
      ctx.dispose();
    },
  };
}
