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
export async function createAppHarness(definition, options) {
    const controller = new AbortController();
    const listeners = new Map();
    let ready = false;
    let revoked = false;
    let artifact = options.artifact ? { ...options.artifact } : undefined;
    let artifactRevision = 0;
    let cleanup;
    const bridge = {
        pluginId: options.pluginId ?? 'dev.vibex.test',
        generation: options.generation ?? 1,
        artifact: artifact
            ? {
                name: artifact.name,
                async readText() {
                    assertSurfaceActive(revoked);
                    return { ...artifact };
                },
                async writeText(content, expectedRevision) {
                    assertSurfaceActive(revoked);
                    if (artifact.revision !== expectedRevision) {
                        throw new PluginSdkError('artifact_revision_conflict', 'The artifact changed outside this editor');
                    }
                    artifactRevision += 1;
                    artifact = {
                        ...artifact,
                        content,
                        revision: `sha256:test-${artifactRevision}`,
                    };
                    return { revision: artifact.revision };
                },
            }
            : undefined,
        async invoke(handler, input = null) {
            assertSurfaceActive(revoked);
            return (await (options.invoke?.(handler, input) ?? null));
        },
        subscribe(channel, listener) {
            assertSurfaceActive(revoked);
            const channelListeners = listeners.get(channel) ?? new Set();
            channelListeners.add(listener);
            listeners.set(channel, channelListeners);
            return () => channelListeners.delete(listener);
        },
        ready() {
            assertSurfaceActive(revoked);
            ready = true;
        },
    };
    cleanup = await definition.mount({
        bridge,
        root: options.root,
        signal: controller.signal,
    });
    const revoke = () => {
        if (revoked)
            return;
        revoked = true;
        controller.abort();
        listeners.clear();
    };
    return {
        bridge,
        signal: controller.signal,
        get ready() {
            return ready;
        },
        emit(channel, payload) {
            assertSurfaceActive(revoked);
            for (const listener of listeners.get(channel) ?? [])
                listener(payload);
        },
        revoke,
        async dispose() {
            revoke();
            await cleanup?.();
        },
    };
}
/**
 * In-memory Host: implements storage, secrets, log, artifact, and doctor.
 * Every other catalog operation fails with capability_unimplemented.
 */
function createMemoryHostClient(hostCalls) {
    const settings = {};
    const kv = new Map();
    const secrets = new Map();
    let artifact = {
        name: "memory.txt",
        content: "",
        revision: "sha256:test-0",
    };
    return {
        async call(capability, operation, input = null) {
            hostCalls.push({ capability, operation, input });
            const key = `${capability}.${operation}`;
            switch (key) {
                case "storage.settings.get":
                    return { ...settings };
                case "storage.settings.put":
                    Object.assign(settings, input?.value ?? input);
                    return { ...settings };
                case "storage.kv.get":
                    return (kv.get(String(input?.key)) ?? null);
                case "storage.kv.put": {
                    const rec = input;
                    if (rec.key)
                        kv.set(rec.key, rec.value ?? null);
                    return (rec.value ?? null);
                }
                case "storage.kv.delete":
                    kv.delete(String(input?.key));
                    return null;
                case "storage.kv.list":
                    return [...kv.keys()];
                case "storage.database.execute":
                case "storage.database.query":
                    return { rows: [], changes: 0 };
                case "secrets.get": {
                    const name = String(input?.name ?? "");
                    const value = secrets.get(name);
                    return (value === undefined ? { present: false } : { present: true, value });
                }
                case "secrets.put": {
                    const rec = input;
                    if (rec.name)
                        secrets.set(rec.name, rec.value ?? "");
                    return { present: true };
                }
                case "secrets.delete":
                    secrets.delete(String(input?.name ?? ""));
                    return { present: false };
                case "log.debug":
                case "log.info":
                case "log.warn":
                case "log.error":
                    return {};
                case "artifact.readText":
                    return { ...artifact };
                case "artifact.writeText": {
                    const rec = input;
                    if (rec.expectedRevision && rec.expectedRevision !== artifact.revision) {
                        throw new PluginSdkError("artifact_revision_conflict", "The artifact changed outside this editor");
                    }
                    artifact = {
                        ...artifact,
                        content: rec.content ?? "",
                        revision: `sha256:test-${Date.now()}`,
                    };
                    return { revision: artifact.revision };
                }
                case "plugin.self.doctor":
                    return { diagnostics: [], recentCrashes: [] };
                default:
                    throw new PluginSdkError("capability_unimplemented", `${key} is not implemented by the in-memory harness`);
            }
        },
    };
}
function assertSurfaceActive(revoked) {
    if (revoked) {
        throw new PluginSdkError('surface_revoked', 'The App surface token has been revoked');
    }
}
