import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { build } from "esbuild";

import { validatePlugin } from "./validation.js";

export async function buildPlugin(root: string) {
  const pluginRoot = resolve(root);
  await mkdir(join(pluginRoot, "dist"), { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".vibex-plugin", "plugin.json"), "utf8"),
  ) as {
    integrations?: Array<{ id?: string; kind?: string; resource?: string }>;
  };
  const workerSource = join(pluginRoot, "runtime", "main.mjs");
  if (await exists(workerSource)) {
    await build({
      entryPoints: [workerSource],
      outfile: join(pluginRoot, "dist", "worker.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      alias: sdkAliases(),
      sourcemap: false,
      minifyWhitespace: true,
      legalComments: "none",
      logLevel: "silent",
    });
  }
  const appSource = join(pluginRoot, "runtime", "app.mjs");
  if (await exists(appSource)) {
    const appRoot = join(pluginRoot, "dist", "app");
    await mkdir(appRoot, { recursive: true });
    const appBundle = await build({
      stdin: {
        contents: `
          import definition from ${JSON.stringify(appSource)};
          const root = document.querySelector('#app') ?? document.body;
          const controller = new AbortController();
          const surface = globalThis.vibexSurface;
          if (!surface) throw new Error('vibex_app_surface_unavailable');
          const bootstrap = await surface.ready;
          const artifact = bootstrap.artifact ? Object.freeze({
            name: bootstrap.artifact.name,
            readText: () => surface.request('artifact.readText', null),
            writeText: (content, expectedRevision) => surface.request('artifact.writeText', { content, expectedRevision }),
          }) : undefined;
          const bridge = Object.freeze({
            pluginId: bootstrap.pluginId,
            generation: bootstrap.generation,
            artifact,
            invoke: (handler, input = null) => surface.request(handler, input),
            subscribe: (channel, listener) => {
              if (channel !== 'context') throw new Error('app_subscription_unsupported');
              const receive = (event) => listener(event.detail);
              addEventListener('vibexsurfacecontext', receive);
              return () => removeEventListener('vibexsurfacecontext', receive);
            },
            ready: () => { void surface.request('surface.ready'); },
          });
          const dispose = await definition.mount({ root, bridge, signal: controller.signal });
          addEventListener('pagehide', () => {
            controller.abort();
            if (typeof dispose === 'function') void dispose();
          }, { once: true });
        `,
        resolveDir: pluginRoot,
        sourcefile: "vibex-app-bootstrap.mjs",
        loader: "js",
      },
      bundle: true,
      outfile: join(appRoot, "surface.js"),
      format: "esm",
      platform: "browser",
      target: "es2022",
      alias: sdkAliases(),
      write: false,
      loader: {
        ".avif": "dataurl",
        ".gif": "dataurl",
        ".jpeg": "dataurl",
        ".jpg": "dataurl",
        ".png": "dataurl",
        ".svg": "dataurl",
        ".webp": "dataurl",
        ".woff": "dataurl",
        ".woff2": "dataurl",
        ".ttf": "dataurl",
      },
      minifyWhitespace: true,
      legalComments: "none",
      logLevel: "silent",
    });
    const document = join(pluginRoot, "runtime", "app.html");
    if (await exists(document)) {
      const html = await readFile(document, "utf8");
      const script = appBundle.outputFiles.find((file) =>
        file.path.endsWith(".js"),
      )?.text;
      if (!script) throw new Error("plugin_app_bundle_missing");
      const css = appBundle.outputFiles.find((file) =>
        file.path.endsWith(".css"),
      )?.text;
      const withoutExternalScripts = html.replace(
        /<script\b[\s\S]*?<\/script\s*>/giu,
        "",
      );
      const inlineScript = `<script type="module">${script.replaceAll("</script", "<\\/script")}</script>`;
      const inlineStyle = css
        ? `<style>${css.replaceAll("</style", "<\\/style")}</style>`
        : "";
      const assets = `${inlineStyle}${inlineScript}`;
      const bundledDocument = withoutExternalScripts.includes("</body>")
        ? withoutExternalScripts.replace("</body>", `${assets}</body>`)
        : `${withoutExternalScripts}${assets}`;
      await writeFile(join(appRoot, "index.html"), bundledDocument);
    }
  }
  for (const integration of manifest.integrations ?? []) {
    if (integration.kind !== "content.mcp" || !integration.resource) continue;
    const resource = JSON.parse(
      await readFile(join(pluginRoot, integration.resource), "utf8"),
    ) as {
      managedRuntime?: { source?: string; entrypoint?: string };
    };
    const managed = resource.managedRuntime;
    if (!managed?.source || !managed.entrypoint) continue;
    const output = join(pluginRoot, managed.entrypoint);
    await mkdir(join(output, ".."), { recursive: true });
    await build({
      entryPoints: [join(pluginRoot, managed.source)],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      sourcemap: false,
      minifyWhitespace: true,
      legalComments: "none",
      logLevel: "silent",
    });
  }
  const result = await validatePlugin(pluginRoot);
  if (!result.valid) {
    throw new Error(
      `plugin_validation_failed: ${result.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(", ")}`,
    );
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function sdkAliases() {
  const require = createRequire(import.meta.url);
  return {
    "@vibex/plugin-sdk": require.resolve("@vibex/plugin-sdk"),
    "@vibex/plugin-sdk/worker": require.resolve("@vibex/plugin-sdk/worker"),
    "@vibex/plugin-sdk/app": require.resolve("@vibex/plugin-sdk/app"),
    "@vibex/plugin-sdk/testing": require.resolve("@vibex/plugin-sdk/testing"),
    "@vibex/plugin-sdk/protocol": require.resolve("@vibex/plugin-sdk/protocol"),
    "@vibex/plugin-sdk/stdio": require.resolve("@vibex/plugin-sdk/stdio"),
  };
}
