import { commandRegistry, conversationModeRegistry, disposePluginRegistrations, internalMessageCaptureRegistry, kanbanViewRegistry, markdownRegistry, overlayRegistry, panelRegistry, promptContextRegistry, providerRegistry, settingRegistry, settingsPageRegistry, slashCommandRegistry, slotRegistry, themeRegistry, viewRegistry, } from './registry.js';
import { EffectScope, serviceContainer, } from './services.js';
let defaultHostCallTransport = null;
let defaultWorkerInvokeTransport = null;
export function setDefaultHostCallTransport(transport) {
    defaultHostCallTransport = transport;
}
export function setDefaultWorkerInvokeTransport(transport) {
    defaultWorkerInvokeTransport = transport;
}
export function qualifyPluginContributionId(pluginId, rawId) {
    const prefix = `plugin:${pluginId}/`;
    if (rawId.startsWith(prefix)) {
        return rawId;
    }
    return `${prefix}${rawId}`;
}
export function createPluginContext(options) {
    const { pluginId, generation = 1 } = options;
    const scope = new EffectScope();
    const hostCall = async (capability, operation, input) => {
        const transport = options.hostCall ?? options.callHost ?? defaultHostCallTransport;
        if (!transport) {
            throw new Error(`HostCallTransport is not configured for plugin "${pluginId}" (${capability}.${operation})`);
        }
        if (transport.length === 1) {
            return await transport({
                pluginId,
                capability,
                operation,
                input: input ?? null,
            });
        }
        return await transport(pluginId, capability, operation, input ?? null);
    };
    const invokeWorker = async (handler, input) => {
        const transport = options.invokeWorker ?? defaultWorkerInvokeTransport;
        if (!transport) {
            throw new Error(`WorkerInvokeTransport is not configured for plugin "${pluginId}" (${handler})`);
        }
        return await transport(pluginId, handler, input ?? null);
    };
    const scopeStack = [scope];
    const currentScope = () => scopeStack[scopeStack.length - 1] ?? scope;
    const track = (disposer) => currentScope().addDisposer(disposer);
    const registerSlot = (contribution) => track(slotRegistry.register({ ...contribution, pluginId }, pluginId));
    const registerCommand = (contribution) => track(commandRegistry.register({ ...contribution, pluginId }, pluginId));
    const registerView = (contribution) => track(viewRegistry.register({
        ...contribution,
        title: contribution.title ?? contribution.id,
        pluginId,
    }, pluginId));
    const registerSettingsSection = (contribution) => track(settingRegistry.register({ ...contribution, pluginId }, pluginId));
    const registerSlashCommand = (contribution) => track(slashCommandRegistry.register({
        ...contribution,
        id: contribution.id ?? contribution.name,
        pluginId,
    }, pluginId));
    const registerPromptContext = (contribution) => track(promptContextRegistry.register({ ...contribution, pluginId }, pluginId));
    const registerProvider = (contribution) => track(providerRegistry.register({ ...contribution, pluginId }, pluginId));
    const registerTheme = (contribution) => track(themeRegistry.register({ ...contribution, pluginId }, pluginId));
    const registerInternalMessageCapture = (contribution) => track(internalMessageCaptureRegistry.register({ ...contribution, pluginId }, pluginId));
    const kvClient = {
        async get(key) {
            const result = await hostCall('storage', 'kv.get', { key });
            return result ?? null;
        },
        async put(key, value) {
            return await hostCall('storage', 'kv.put', { key, value });
        },
        async set(key, value) {
            return await hostCall('storage', 'kv.put', { key, value });
        },
        async delete(key) {
            await hostCall('storage', 'kv.delete', { key });
        },
        async list(prefix) {
            return await hostCall('storage', 'kv.list', prefix ? { prefix } : {});
        },
        async clear() {
            return await hostCall('storage', 'kv.clear', {});
        },
    };
    const settingsClient = {
        async get() {
            return await hostCall('storage', 'settings.get', {});
        },
        async put(value) {
            return await hostCall('storage', 'settings.put', value);
        },
        async set(value) {
            return await hostCall('storage', 'settings.put', value);
        },
    };
    const networkClient = {
        async fetch(input) {
            return await hostCall('network', 'fetch', {
                url: input.url,
                method: input.method ?? 'GET',
                headers: (input.headers ?? {}),
                body: input.body ?? null,
                timeoutMs: input.timeoutMs ?? 30_000,
            });
        },
    };
    const conversationClient = {
        async call(operation, input) {
            return await hostCall('conversation', operation, input ?? {});
        },
    };
    const browserClient = {
        async call(operation, input) {
            return await hostCall('browser', operation, input ?? {});
        },
    };
    const execClient = {
        async run(input) {
            return await hostCall('exec', 'run', {
                program: input.program,
                args: (input.args ?? []),
                ...(input.cwd ? { cwd: input.cwd } : {}),
                ...(input.env ? { env: input.env } : {}),
                ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
                ...(input.timeoutMs !== undefined
                    ? { timeoutMs: input.timeoutMs }
                    : {}),
            });
        },
        async spawn(input) {
            return await hostCall('exec', 'spawn', {
                program: input.program,
                args: (input.args ?? []),
                ...(input.cwd ? { cwd: input.cwd } : {}),
                ...(input.env ? { env: input.env } : {}),
            });
        },
        async kill(processId) {
            return await hostCall('exec', 'kill', processId ? { processId } : {});
        },
        async status(processId) {
            return await hostCall('exec', 'status', {
                processId,
            });
        },
    };
    const notifyClient = {
        async toast(input) {
            return await hostCall('app', 'notify.toast', {
                title: input.title,
                message: input.message ?? '',
                variant: input.variant ?? 'info',
                durationMs: input.durationMs ?? 4000,
            });
        },
        async notify(input) {
            return await notifyClient.toast(input);
        },
    };
    const ui = {
        registerSlot,
        registerView,
        registerPanel(contribution) {
            const disposePanel = track(panelRegistry.register({ ...contribution, pluginId }, pluginId));
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
            const disposeKanban = track(kanbanViewRegistry.register({ ...contribution, pluginId }, pluginId));
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
            const disposePage = track(settingsPageRegistry.register({ ...contribution, pluginId }, pluginId));
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
            const normalizedLabel = contribution.label ?? contribution.title ?? contribution.id;
            const disposeMode = track(conversationModeRegistry.register({
                ...contribution,
                label: normalizedLabel,
                takeover: contribution.takeover ??
                    Boolean(contribution.component || contribution.render),
                pluginId,
            }, pluginId));
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
            const disposeMarkdown = track(markdownRegistry.register({
                ...contribution,
                language,
                pluginId,
            }, pluginId));
            const disposeSlot = registerSlot({
                id: contribution.id,
                label: Array.isArray(language) ? language.join(',') : String(language),
                component: contribution.component,
                render: contribution.render,
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
            const disposeOverlay = track(overlayRegistry.register({ ...contribution, pluginId }, pluginId));
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
                onActivate: contribution.onActivate ??
                    (action ? (ctx) => action(ctx ?? {}) : undefined),
                slot: contribution.slot ?? 'message.context-menu',
            });
        },
    };
    let hookCounter = 0;
    const hooks = {
        beforeTurn(fn, order = 0) {
            const wrapped = async (turn, next) => {
                let nextCalled = false;
                let currentTurn = turn;
                const callNext = async (nextPayload) => {
                    nextCalled = true;
                    currentTurn = (await next(nextPayload ?? turn));
                    return currentTurn;
                };
                const result = await fn(turn, callNext);
                if (!nextCalled) {
                    currentTurn = (await next(turn));
                }
                if (typeof result === 'string' &&
                    result.trim() &&
                    currentTurn &&
                    typeof currentTurn === 'object' &&
                    Array.isArray(currentTurn.internalPromptContributions)) {
                    currentTurn.internalPromptContributions.push({
                        pluginId,
                        label: null,
                        content: result.trim(),
                        priority: order,
                    });
                    return currentTurn;
                }
                if (result &&
                    typeof result === 'object' &&
                    !Array.isArray(result) &&
                    ('content' in result ||
                        'hiddenContext' in result ||
                        'appendPrompt' in result ||
                        'prependSystemPrompt' in result ||
                        'blocks' in result ||
                        ('text' in result && !('internalPromptContributions' in result)))) {
                    const r = result;
                    if (typeof r.text === 'string' &&
                        r.text.trim() &&
                        currentTurn &&
                        typeof currentTurn === 'object') {
                        currentTurn = { ...currentTurn, text: r.text };
                    }
                    const content = r.content?.trim() ||
                        r.hiddenContext?.trim() ||
                        r.appendPrompt?.trim() ||
                        r.prependSystemPrompt?.trim();
                    if (content &&
                        currentTurn &&
                        typeof currentTurn === 'object' &&
                        Array.isArray(currentTurn.internalPromptContributions)) {
                        currentTurn.internalPromptContributions.push({
                            pluginId,
                            label: r.label ?? null,
                            content,
                            priority: r.priority ?? order,
                        });
                    }
                    if (Array.isArray(r.blocks) &&
                        currentTurn &&
                        typeof currentTurn === 'object' &&
                        Array.isArray(currentTurn.internalPromptContributions)) {
                        for (const block of r.blocks) {
                            const blockContent = block?.content?.trim();
                            if (!blockContent)
                                continue;
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
            return track(serviceContainer.intercept('conversation.beforeTurn', wrapped, order, pluginId));
        },
        afterTurn(fn, order = 0) {
            const wrapped = async (event, next) => {
                let nextCalled = false;
                let out = event;
                const callNext = async (nextPayload) => {
                    nextCalled = true;
                    out = await next(nextPayload ?? event);
                    return out;
                };
                const res = await fn(event, callNext);
                if (!nextCalled) {
                    out = await next(event);
                }
                return res !== undefined ? res : out;
            };
            return track(serviceContainer.intercept('conversation.afterTurn', wrapped, order, pluginId));
        },
        onRuntimeEvent(fn, order = 0) {
            const wrapped = async (event, next) => {
                let nextCalled = false;
                let out = event;
                const callNext = async (nextPayload) => {
                    nextCalled = true;
                    out = await next(nextPayload ?? event);
                    return out;
                };
                const res = await fn(event, callNext);
                if (!nextCalled) {
                    out = await next(event);
                }
                return res !== undefined ? res : out;
            };
            return track(serviceContainer.intercept('runtime.event', wrapped, order, pluginId));
        },
        captureInternalMessage(channelOrContribution, onCapture, options) {
            hookCounter += 1;
            if (typeof channelOrContribution === 'string') {
                if (!onCapture) {
                    throw new Error('captureInternalMessage(channel, onCapture) requires an onCapture handler');
                }
                return registerInternalMessageCapture({
                    id: options?.id ??
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
                id: channelOrContribution.id ??
                    `${pluginId}:internal:${channelOrContribution.channel}:${hookCounter}`,
            });
        },
        intercept(hookName, fn, order = 0) {
            return track(serviceContainer.intercept(hookName, fn, order, pluginId));
        },
    };
    function injectImpl(keyOrDeps, effect) {
        if (Array.isArray(keyOrDeps)) {
            if (typeof effect !== 'function') {
                throw new Error('ctx.services.inject(deps, effect) requires an effect callback');
            }
            const wrappedEffect = (resolved) => {
                const subScope = new EffectScope();
                scopeStack.push(subScope);
                try {
                    const maybeCleanup = effect(resolved);
                    if (typeof maybeCleanup === 'function') {
                        subScope.addDisposer(maybeCleanup);
                    }
                }
                finally {
                    scopeStack.pop();
                }
                return () => {
                    subScope.dispose();
                };
            };
            return track(serviceContainer.inject(keyOrDeps, wrappedEffect, pluginId));
        }
        return serviceContainer.inject(keyOrDeps);
    }
    const services = {
        provide(key, implementation) {
            return track(serviceContainer.provide(key, implementation, pluginId));
        },
        get(key) {
            return serviceContainer.get(key);
        },
        inject: injectImpl,
        require(key) {
            return serviceContainer.require(key);
        },
        intercept(hookName, fn, order = 0) {
            return track(serviceContainer.intercept(hookName, fn, order, pluginId));
        },
        onChange(key, listener) {
            return track(serviceContainer.onServiceChange(key, listener));
        },
    };
    const host = {
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
        effects: scope,
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
export function defineVibeXPlugin(definition) {
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
export function isVibeXPluginDefinition(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value;
    return (candidate.apiVersion === '2.0' && typeof candidate.activate === 'function');
}
