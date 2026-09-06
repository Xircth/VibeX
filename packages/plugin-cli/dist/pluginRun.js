import { resolve } from "node:path";
import { buildPlugin } from "./build.js";
import { watchPluginSources } from "./dev.js";
import { loadHostSession, mergeHostSession, parseHostFlags, requireHostSession, resolveHostSession, saveHostSession, } from "./hostSession.js";
import { inspectLinkedPackage } from "./pluginControl.js";
import { testPlugin } from "./pluginTest.js";
import { enableOnProductHost, importLinkedOnProductHost, pingProductHost, } from "./productHost.js";
import { readPluginRemotes, startPluginRemoteDev } from "./remoteDev.js";
export const RUN_SCRIPTS = ["server", "dev", "build", "test"];
export function parseRunInvocation(args) {
    const script = args[0];
    if (!script) {
        throw new Error("Usage: vibex plugin run <server|dev|build|test>");
    }
    if (!isRunScript(script)) {
        throw new Error(`Unknown plugin script: ${script}\nUsage: vibex plugin run <server|dev|build|test>`);
    }
    const afterScript = args.slice(1);
    const hostJourney = script === "test" && afterScript.includes("--host");
    const { flags, rest } = parseHostFlags(script === "test"
        ? afterScript.filter((item) => item !== "--host")
        : afterScript);
    return { script, host: flags, positional: rest, hostJourney };
}
export async function bindHostServer(options) {
    const session = requireHostSession(mergeHostSession(options.flags, options.saved === undefined ? loadHostSession() : options.saved));
    const ping = options.ping ?? pingProductHost;
    if (!(await ping(session))) {
        throw new Error(`Host ${session.url} did not accept the token.`);
    }
    (options.save ?? saveHostSession)(session);
    return session;
}
export async function runPluginDev(root, options = {}) {
    const log = options.log ?? console.log;
    const resolved = resolve(root);
    await buildPlugin(resolved);
    const plugin = await inspectLinkedPackage(resolved);
    const publish = async (reload) => {
        requireHostSession(resolveHostSession());
        const installed = await importLinkedOnProductHost(plugin.root, plugin.identity);
        if (installed.queued) {
            requireHostSession(null);
        }
        if (!reload)
            await enableOnProductHost(plugin.identity.id);
        return installed;
    };
    const first = await publish(false);
    log(`Linked ${plugin.identity.id} as a development plugin (generation ${first.generation}); watching ${resolved}`);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const remotes = await readPluginRemotes(resolved);
    if (remotes.length > 0) {
        await startPluginRemoteDev({
            root: resolved,
            remotes,
            signal: controller.signal,
            onReady(entry) {
                log(`Remote HMR at ${entry}`);
            },
            onError(error) {
                console.error(error instanceof Error ? error.message : String(error));
            },
        });
        const published = await publish(true);
        log(`Published generation ${published.generation} with live remotes`);
    }
    try {
        await watchPluginSources(resolved, {
            signal: controller.signal,
            ignoreRemoteSources: remotes.length > 0,
            async reload() {
                await buildPlugin(resolved);
                if (controller.signal.aborted)
                    return;
                const candidate = await publish(true);
                log(`Published generation ${candidate.generation}`);
            },
            onError(error) {
                console.error(error instanceof Error ? error.message : String(error));
            },
        });
    }
    finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    }
}
export async function runPluginBuild(root) {
    const resolved = resolve(root);
    await buildPlugin(resolved);
    return resolved;
}
export async function runPluginTest(root, options = {}) {
    await testPlugin(resolve(root), options);
}
function isRunScript(value) {
    return RUN_SCRIPTS.includes(value);
}
