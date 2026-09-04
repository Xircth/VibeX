import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startFederationDevServer } from "./federationBuild.js";
export const DEV_REMOTE_SIDECAR = ".vibex-plugin/dev-remote.json";
export function remotesFromManifest(manifest) {
    if (!manifest || typeof manifest !== "object")
        return [];
    const integrations = manifest.integrations;
    if (!Array.isArray(integrations))
        return [];
    const remotes = [];
    const seen = new Set();
    for (const item of integrations) {
        if (!item || typeof item !== "object")
            continue;
        const remote = item.remote;
        if (!remote || typeof remote !== "object")
            continue;
        const name = remote.name;
        const entry = remote.entry;
        const module = remote.module;
        if (typeof name !== "string" || !name)
            continue;
        if (typeof entry !== "string" || !entry)
            continue;
        if (seen.has(name))
            continue;
        seen.add(name);
        remotes.push({
            name,
            entry,
            module: typeof module === "string" && module ? module : "./view",
        });
    }
    return remotes;
}
export async function readPluginRemotes(root) {
    const raw = await readFile(join(root, ".vibex-plugin", "plugin.json"), "utf8");
    return remotesFromManifest(JSON.parse(raw));
}
export async function startPluginRemoteDev(options) {
    if (options.remotes.length === 0)
        return null;
    const root = resolve(options.root);
    const remote = options.remotes[0];
    const port = await freePort();
    const entry = `http://127.0.0.1:${port}/remoteEntry.js`;
    await writeDevRemote(root, {
        name: remote.name,
        entry,
        module: remote.module,
    });
    const server = await startFederationDevServer({
        root,
        remotes: options.remotes,
        port,
    });
    const close = async () => {
        await server.close();
        await rm(join(root, DEV_REMOTE_SIDECAR), { force: true });
    };
    options.signal.addEventListener("abort", () => {
        void close();
    }, { once: true });
    try {
        await waitForHttp(entry, options.signal);
    }
    catch (error) {
        await close();
        options.onError?.(error);
        throw error;
    }
    options.onReady?.(entry);
    return { entry, close };
}
async function writeDevRemote(root, remote) {
    await mkdir(join(root, ".vibex-plugin"), { recursive: true });
    await writeFile(join(root, DEV_REMOTE_SIDECAR), `${JSON.stringify(remote, null, 2)}\n`);
}
async function waitForHttp(url, signal) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !signal.aborted) {
        try {
            const response = await fetch(url, { signal });
            if (response.ok || response.status === 404)
                return;
        }
        catch {
            await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        }
    }
    throw new Error("plugin_remote_dev_timeout");
}
async function freePort() {
    return await new Promise((resolvePort, reject) => {
        const server = createNetServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close((error) => {
                if (error)
                    reject(error);
                else if (address && typeof address === "object")
                    resolvePort(address.port);
                else
                    reject(new Error("remote_dev_port_unavailable"));
            });
        });
    });
}
