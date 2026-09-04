import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { federation } from "@module-federation/vite";
import { build as viteBuild, createServer, type ViteDevServer } from "vite";

const require = createRequire(import.meta.url);

function resolveHostPackage(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

import type { PluginRemoteDeclaration } from "./remoteDev.js";

const VIEW_MODULE = "./src/views/view.tsx";

export function federationContainerName(
  remotes: readonly PluginRemoteDeclaration[],
): string | null {
  return remotes[0]?.name ?? null;
}

export async function buildFederationRemotes(
  root: string,
  remotes: readonly PluginRemoteDeclaration[],
): Promise<void> {
  if (remotes.length === 0) return;
  const pluginRoot = resolve(root);
  const viewPath = join(pluginRoot, "src/views/view.tsx");
  const entry = remotes[0]?.entry ?? "dist/remoteEntry.js";
  const builtEntry = join(pluginRoot, entry);
  if (!existsSync(viewPath)) {
    if (existsSync(builtEntry) || entry.startsWith("http")) return;
    throw new Error(`plugin_remote_view_missing: ${VIEW_MODULE}`);
  }
  const name = federationContainerName(remotes);
  if (!name) return;
  await viteBuild(federationViteConfig(pluginRoot, name, viewPath));
}

export async function startFederationDevServer(options: {
  root: string;
  remotes: readonly PluginRemoteDeclaration[];
  port: number;
}): Promise<ViteDevServer> {
  const name = federationContainerName(options.remotes);
  if (!name) throw new Error("plugin_remote_missing");
  const server = await createServer({
    ...federationViteConfig(
      resolve(options.root),
      name,
      join(resolve(options.root), "src/views/view.tsx"),
    ),
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

function federationViteConfig(
  pluginRoot: string,
  name: string,
  viewPath: string,
) {
  return {
    root: pluginRoot,
    configFile: false as const,
    appType: "custom" as const,
    plugins: [federationPlugin(name)],
    resolve: {
      alias: {
        react: resolveHostPackage("react"),
        "react-dom": resolveHostPackage("react-dom"),
      },
    },
    esbuild: {
      jsx: "automatic" as const,
    },
    build: {
      target: "esnext",
      outDir: "dist",
      emptyOutDir: false,
      rollupOptions: {
        input: viewPath,
      },
    },
    logLevel: "warn" as const,
  };
}

function federationPlugin(name: string) {
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
