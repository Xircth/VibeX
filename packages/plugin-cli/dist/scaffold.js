import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultPluginName } from "./package.js";
export async function scaffoldPlugin(target, publisher = "local", template = "full") {
    if (!["full", "app", "agent"].includes(template)) {
        throw new Error(`plugin_template_unknown: ${template}`);
    }
    const root = resolve(target);
    const id = defaultPluginName(root);
    const hasApp = template !== "agent";
    const hasAgent = template !== "app";
    const entrypoints = {
        worker: {
            path: "dist/worker.mjs",
            format: "javascript-esm",
            protocol: "1.0",
        },
        ...(hasApp
            ? {
                app: {
                    root: "dist/app",
                    document: "index.html",
                    protocol: "1.0",
                },
            }
            : {}),
    };
    const integrations = [
        ...(hasAgent
            ? [
                {
                    id: "hello",
                    kind: "workflow.binding",
                    resource: "contents/workflows/hello/workflow.json",
                },
            ]
            : []),
        ...(hasApp
            ? [
                {
                    id: "text",
                    kind: "file.opener",
                    label: "Text preview",
                    extensions: ["txt"],
                    previewProvider: "text",
                },
                {
                    id: "text",
                    kind: "artifact.preview",
                    mediaTypes: ["text/plain"],
                    handler: "preview-text",
                },
                {
                    id: "dashboard",
                    kind: "app.surface",
                    label: "Dashboard",
                    slot: "plugin.detail.panel",
                    appEntrypoint: "app",
                    handler: "surface.createSession",
                    allowedMethods: ["hello"],
                    minHeight: 320,
                },
            ]
            : []),
    ];
    await mkdir(join(root, ".vibex-plugin"), { recursive: true });
    await mkdir(join(root, "contents", "workflows", "hello"), {
        recursive: true,
    });
    await mkdir(join(root, "depends", "runtimes"), { recursive: true });
    await mkdir(join(root, "runtime"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, ".vibex-plugin", "plugin.json"), `${JSON.stringify({
        $schema: "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
        manifestVersion: 4,
        apiVersion: "1.0",
        id,
        publisher,
        version: "0.1.0",
        name: id,
        readme: "README.md",
        engines: { vibex: ">=0.1.3", pluginSdk: "^1.0.0" },
        content: {
            root: "contents",
            index: ".vibex-plugin/content.index.json",
        },
        config: {
            schema: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
        },
        entrypoints,
        integrations,
    }, null, 2)}\n`);
    await writeFile(join(root, "README.md"), `---\nsummary: Add ${id} features to VibeX.\n---\n# ${id}\n\nDescribe how to use this plugin.\n`);
    await writeFile(join(root, "config.json"), "{}\n");
    await writeFile(join(root, ".vibex-plugin", "content.index.json"), `${JSON.stringify({
        schemaVersion: 1,
        items: hasAgent
            ? [
                {
                    path: "contents/workflows/hello/workflow.json",
                    kind: "workflow",
                    title: "Hello",
                },
            ]
            : [],
    }, null, 2)}\n`);
    if (hasAgent) {
        await writeFile(join(root, "contents", "workflows", "hello", "workflow.json"), `${JSON.stringify({
            label: "Hello",
            entrypoints: ["action", "command"],
            handler: "hello",
        }, null, 2)}\n`);
    }
    await writeFile(join(root, "runtime", "main.mjs"), `import { definePluginWorker } from '@vibex/plugin-sdk/worker';\n\nexport default definePluginWorker((plugin) => {\n${hasApp ? "  plugin.handle('surface.createSession', async () => ({ ready: true }));\n  plugin.handle('preview-text', async (input) => ({ kind: 'text', input }));\n" : ""}  plugin.handle('hello', async (input) => ({ message: 'Hello from VibeX', input }));\n});\n`);
    if (hasApp) {
        await writeFile(join(root, "runtime", "app.mjs"), `import { definePluginApp } from '@vibex/plugin-sdk/app';\nimport './app.css';\n\nexport default definePluginApp(({ root, bridge }) => {\n  const button = document.createElement('button');\n  button.textContent = 'Hello from VibeX';\n  button.addEventListener('click', () => void bridge.invoke('hello'));
  root.append(button);\n  bridge.ready();\n  return () => button.remove();\n});\n`);
        await writeFile(join(root, "runtime", "app.css"), `:root { color-scheme: light dark; font: 13px system-ui, sans-serif; }\nbody { margin: 0; }\nbutton { font: inherit; }\n`);
        await writeFile(join(root, "runtime", "app.html"), '<!doctype html><html><body><main id="app"></main><script type="module" src="./app.mjs"></script></body></html>\n');
    }
    await writeFile(join(root, "test", "plugin.test.mjs"), `import test from 'node:test';
import assert from 'node:assert/strict';
import definition from '../dist/worker.mjs';
import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

test('registers every required Worker handler', async () => {
  const worker = await createWorkerHarness(definition);
  assert.deepEqual(worker.handlers, ${JSON.stringify([
        "hello",
        ...(hasApp ? ["preview-text", "surface.createSession"] : []),
    ].sort())});
  await assert.rejects(() => worker.invoke('undeclared', null), /not registered/);
  await worker.dispose();
});
`);
    await writeFile(join(root, "package.json"), `${JSON.stringify({
        name: `${publisher}.${id}`,
        private: true,
        type: "module",
        scripts: {
            build: "vibex-plugin build",
            test: "vibex-plugin test",
            "test:plugin": "node --test test/plugin.test.mjs",
        },
        dependencies: { "@vibex/plugin-sdk": "^1.0.0" },
        devDependencies: { "@vibex/plugin-cli": "^1.0.0" },
    }, null, 2)}\n`);
    return root;
}
