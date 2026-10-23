import { createPluginContext, } from './context.js';
import { commandRegistry, conversationModeRegistry, kanbanViewRegistry, markdownRegistry, overlayRegistry, panelRegistry, settingRegistry, settingsPageRegistry, slashCommandRegistry, slotRegistry, viewRegistry, } from './registry.js';
import { activatePluginWorker, PluginSdkError, } from './worker.js';
export async function createWorkerHarness(definition, options = {}) {
    const hostCalls = [];
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
            debug() { },
            info() { },
            warn() { },
            error() { },
        },
    });
    return Object.assign(worker, { hostCalls });
}
export async function createGenerationHarness(definition, options = {}) {
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
            }
            catch (error) {
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
function assertRequiredHandlers(worker, requiredHandlers) {
    for (const handler of requiredHandlers ?? []) {
        if (!worker.handlers.includes(handler)) {
            throw new PluginSdkError('required_handler_missing', `Required handler ${handler} is not registered`);
        }
    }
}
/**
 * In-memory Host: implements storage, secrets, log, artifact, network, exec, notify, and doctor.
 * Every other catalog operation fails with capability_unimplemented.
 */
function createMemoryHostClient(hostCalls) {
    const settings = {};
    const kv = new Map();
    const secrets = new Map();
    let artifact = {
        name: 'memory.txt',
        content: '',
        revision: 'sha256:test-0',
    };
    return {
        async call(capability, operation, input = null) {
            hostCalls.push({ capability, operation, input });
            const key = `${capability}.${operation}`;
            switch (key) {
                case 'storage.settings.get':
                    return { ...settings };
                case 'storage.settings.put':
                    Object.assign(settings, input?.value ?? input);
                    return { ...settings };
                case 'storage.kv.get':
                    return (kv.get(String(input?.key)) ??
                        null);
                case 'storage.kv.put': {
                    const rec = input;
                    if (rec.key)
                        kv.set(rec.key, rec.value ?? null);
                    return (rec.value ?? null);
                }
                case 'storage.kv.delete':
                    kv.delete(String(input?.key));
                    return null;
                case 'storage.kv.list':
                    return [...kv.keys()];
                case 'storage.kv.clear': {
                    const removed = kv.size;
                    kv.clear();
                    return { removed };
                }
                case 'network.fetch':
                    return {
                        status: 200,
                        ok: true,
                        statusText: 'OK',
                        headers: {},
                        body: '',
                        bodyText: '',
                    };
                case 'exec.run':
                    return {
                        exitCode: 0,
                        stdout: '',
                        stderr: '',
                        success: true,
                    };
                case 'exec.spawn':
                    return {
                        processId: 'proc-test-1',
                        pid: 12345,
                    };
                case 'exec.kill':
                    return {
                        killed: true,
                        processId: input?.processId,
                    };
                case 'exec.status':
                    return {
                        processId: String(input?.processId ?? 'proc-test-1'),
                        running: false,
                        exitCode: 0,
                    };
                case 'app.notify.toast':
                    return { notified: true };
                case 'storage.database.execute':
                case 'storage.database.query':
                    return { rows: [], changes: 0 };
                case 'secrets.get': {
                    const name = String(input?.name ?? '');
                    const value = secrets.get(name);
                    return (value === undefined
                        ? { present: false }
                        : { present: true, value });
                }
                case 'secrets.put': {
                    const rec = input;
                    if (rec.name)
                        secrets.set(rec.name, rec.value ?? '');
                    return { present: true };
                }
                case 'secrets.delete':
                    secrets.delete(String(input?.name ?? ''));
                    return { present: false };
                case 'log.debug':
                case 'log.info':
                case 'log.warn':
                case 'log.error':
                    return {};
                case 'artifact.readText':
                    return { ...artifact };
                case 'artifact.writeText': {
                    const rec = input;
                    if (rec.expectedRevision &&
                        rec.expectedRevision !== artifact.revision) {
                        throw new PluginSdkError('artifact_revision_conflict', 'The artifact changed outside this editor');
                    }
                    artifact = {
                        ...artifact,
                        content: rec.content ?? '',
                        revision: `sha256:test-${Date.now()}`,
                    };
                    return { revision: artifact.revision };
                }
                case 'plugin.self.doctor':
                    return { diagnostics: [], recentCrashes: [] };
                default:
                    throw new PluginSdkError('capability_unimplemented', `${key} is not implemented by the in-memory harness`);
            }
        },
    };
}
function isDirectPluginTarget(value) {
    return (typeof value === 'function' ||
        (typeof value === 'object' &&
            value !== null &&
            'activate' in value &&
            typeof value.activate === 'function'));
}
export function createPluginTestHarness(optionsOrPlugin = {}) {
    const direct = isDirectPluginTarget(optionsOrPlugin);
    const defaultPlugin = direct
        ? optionsOrPlugin
        : optionsOrPlugin.plugin;
    const pluginId = direct
        ? typeof optionsOrPlugin === 'object' && optionsOrPlugin.id
            ? optionsOrPlugin.id
            : 'dev.vibex.test'
        : (optionsOrPlugin.pluginId ?? 'dev.vibex.test');
    const generation = direct ? 1 : (optionsOrPlugin.generation ?? 1);
    const hostCalls = [];
    const memoryHost = (!direct ? optionsOrPlugin.host : undefined) ??
        createMemoryHostClient(hostCalls);
    const ctx = createPluginContext({
        pluginId,
        generation,
        callHost: async (_pid, capability, operation, input) => {
            return (await memoryHost.call(capability, operation, input ?? null));
        },
    });
    let deactivateFn;
    let customDisposer;
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
                throw new Error('createPluginTestHarness.activate() requires a plugin definition or activate function');
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
        getSlots(slot) {
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
