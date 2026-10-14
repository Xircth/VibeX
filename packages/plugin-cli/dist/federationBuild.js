import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { federation } from "@module-federation/vite";
import { build as viteBuild, createServer } from "vite";
const require = createRequire(import.meta.url);
function resolveHostPackage(name) {
    return dirname(require.resolve(`${name}/package.json`));
}
const VIEW_MODULE = "./src/views/view.tsx";
export function federationContainerName(remotes) {
    return remotes[0]?.name ?? null;
}
export async function buildFederationRemotes(root, remotes) {
    if (remotes.length === 0)
        return;
    const pluginRoot = resolve(root);
    const viewPath = join(pluginRoot, "src/views/view.tsx");
    const entry = remotes[0]?.entry ?? "dist/remoteEntry.js";
    const builtEntry = join(pluginRoot, entry);
    if (!existsSync(viewPath)) {
        if (existsSync(builtEntry) || entry.startsWith("http"))
            return;
        throw new Error(`plugin_remote_view_missing: ${VIEW_MODULE}`);
    }
    const name = federationContainerName(remotes);
    if (!name)
        return;
    await viteBuild(federationViteConfig(pluginRoot, name, viewPath));
}
export async function startFederationDevServer(options) {
    const name = federationContainerName(options.remotes);
    if (!name)
        throw new Error("plugin_remote_missing");
    const server = await createServer({
        ...federationViteConfig(resolve(options.root), name, join(resolve(options.root), "src/views/view.tsx")),
        server: {
            host: "127.0.0.1",
            port: options.port,
            strictPort: true,
            cors: true,
        },
        clearScreen: false,
    });
    await server.listen();
    return server;
}
function canResolveFrom(root, name) {
    try {
        const localRequire = createRequire(join(root, "package.json"));
        localRequire.resolve(`${name}/package.json`);
        return true;
    }
    catch {
        return false;
    }
}
function federationViteConfig(pluginRoot, name, viewPath) {
    const alias = {};
    if (!canResolveFrom(pluginRoot, "react")) {
        alias.react = resolveHostPackage("react");
    }
    if (!canResolveFrom(pluginRoot, "react-dom")) {
        alias["react-dom"] = resolveHostPackage("react-dom");
    }
    return {
        root: pluginRoot,
        configFile: false,
        appType: "custom",
        plugins: [federationPlugin(name)],
        ...(Object.keys(alias).length > 0 ? { resolve: { alias } } : {}),
        optimizeDeps: {
            entries: [viewPath],
        },
        esbuild: {
            jsx: "transform",
            jsxFactory: "React.createElement",
            jsxFragment: "React.Fragment",
        },
        build: {
            target: "esnext",
            outDir: "dist",
            emptyOutDir: false,
            rollupOptions: {
                input: viewPath,
            },
        },
        logLevel: "warn",
    };
}
function federationPlugin(name) {
    return federation({
        name,
        filename: "remoteEntry.js",
        dts: false,
        exposes: { "./view": VIEW_MODULE },
        shared: {
            react: { singleton: true, requiredVersion: false },
            "react-dom": { singleton: true, requiredVersion: false },
        },
    });
}
