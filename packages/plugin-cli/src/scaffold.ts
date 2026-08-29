import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { defaultPluginName } from "./package.js";

export const PLUGIN_TEMPLATES = [
  "skill",
  "mcp",
  "file-tab",
  "editor-tab",
  "full",
  "ts-worker",
  "node-worker",
  "python-worker",
  "rust-worker",
  "host-service",
  "hooks",
] as const;

export type PluginTemplate = (typeof PLUGIN_TEMPLATES)[number];

const TEMPLATE_SET = new Set<string>(PLUGIN_TEMPLATES);

export function isPluginTemplate(value: string): value is PluginTemplate {
  return TEMPLATE_SET.has(value);
}

export async function scaffoldPlugin(
  target: string,
  publisher = "local",
  template: string = "full",
) {
  if (!isPluginTemplate(template)) {
    throw new Error(`plugin_template_unknown: ${template}`);
  }
  const root = resolve(target);
  const id = defaultPluginName(root);
  const spec = templateSpec(template);
  await mkdir(join(root, ".vibex-plugin"), { recursive: true });
  await writeJson(join(root, ".vibex-plugin", "plugin.json"), {
    $schema: "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
    manifestVersion: 4,
    apiVersion: "1.0",
    id,
    publisher,
    version: "0.1.0",
    name: id,
    readme: "README.md",
    engines: { vibex: ">=0.1.3 <1.0.0", pluginSdk: "^1.0.0" },
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
    ...(spec.entrypoints ? { entrypoints: spec.entrypoints } : {}),
    integrations: spec.integrations,
  });
  await writeFile(
    join(root, "README.md"),
    `---\nsummary: Add ${id} features to VibeX.\n---\n# ${id}\n\nDescribe how to use this plugin.\n`,
  );
  await writeFile(join(root, "config.json"), "{}\n");
  await writeJson(join(root, ".vibex-plugin", "content.index.json"), {
    schemaVersion: 1,
    items: spec.contentItems,
  });
  await writeJson(join(root, "package.json"), {
    name: `${publisher}.${id}`,
    private: true,
    type: "module",
    scripts: {
      build: "vibex-plugin build",
      test: "vibex-plugin test",
      ...(spec.nodeHandlers
        ? { "test:plugin": "node --test test/plugin.test.mjs" }
        : {}),
      dev: "vibex-plugin dev",
    },
    ...(spec.usesJsSdk
      ? { dependencies: { "@vibex/plugin-sdk": "^1.0.0" } }
      : {}),
    devDependencies: { "@vibex/plugin-cli": "^1.0.0" },
  });
  await writePluginTest(root, spec.nodeHandlers);
  if (spec.hasSkill) await writeSkill(root);
  if (spec.hasWorkflow) await writeWorkflow(root);
  if (spec.hasMcp) await writeManagedMcp(root);
  if (spec.hasHook) await writeHook(root);
  if (spec.nodeWorker) await writeNodeWorker(root, template, spec);
  if (spec.hasApp) await writeAppSurface(root);
  if (template === "python-worker") await writePythonWorker(root, id);
  if (template === "rust-worker") await writeRustWorker(root, id);
  return root;
}

interface TemplateSpec {
  entrypoints?: {
    worker?: { path: string; runtime: "node" | "python" | "native"; protocol: "1.1" };
    app?: { root: string; document: string; protocol: "1.0" };
  };
  integrations: Array<Record<string, unknown>>;
  contentItems: Array<{ path: string; kind: string; title: string }>;
  nodeHandlers: string[] | null;
  nodeWorker: boolean;
  usesJsSdk: boolean;
  hasApp: boolean;
  hasSkill: boolean;
  hasWorkflow: boolean;
  hasMcp: boolean;
  hasHook: boolean;
}

function templateSpec(template: PluginTemplate): TemplateSpec {
  const worker = {
    node: nodeWorkerEntrypoint(),
    python: {
      path: "runtime/worker.py",
      runtime: "python" as const,
      protocol: "1.1" as const,
    },
    native: {
      path: "runtime/src/main.rs",
      runtime: "native" as const,
      protocol: "1.1" as const,
    },
  };
  switch (template) {
    case "skill":
      return {
        integrations: [skillIntegration()],
        contentItems: [skillContent()],
        nodeHandlers: null,
        nodeWorker: false,
        usesJsSdk: false,
        hasApp: false,
        hasSkill: true,
        hasWorkflow: false,
        hasMcp: false,
        hasHook: false,
      };
    case "mcp":
      return {
        integrations: [mcpIntegration()],
        contentItems: [mcpContent()],
        nodeHandlers: null,
        nodeWorker: false,
        usesJsSdk: false,
        hasApp: false,
        hasSkill: false,
        hasWorkflow: false,
        hasMcp: true,
        hasHook: false,
      };
    case "hooks":
      return {
        integrations: [hookIntegration()],
        contentItems: [hookContent()],
        nodeHandlers: null,
        nodeWorker: false,
        usesJsSdk: false,
        hasApp: false,
        hasSkill: false,
        hasWorkflow: false,
        hasMcp: false,
        hasHook: true,
      };
    case "file-tab":
      return {
        entrypoints: { worker: worker.node, app: appEntrypoint() },
        integrations: fileTabIntegrations(),
        contentItems: [],
        nodeHandlers: ["hello", "preview-text", "surface.createSession"],
        nodeWorker: true,
        usesJsSdk: true,
        hasApp: true,
        hasSkill: false,
        hasWorkflow: false,
        hasMcp: false,
        hasHook: false,
      };
    case "editor-tab":
      return {
        entrypoints: { worker: worker.node, app: appEntrypoint() },
        integrations: editorTabIntegrations(),
        contentItems: [],
        nodeHandlers: ["hello", "surface.createSession"],
        nodeWorker: true,
        usesJsSdk: true,
        hasApp: true,
        hasSkill: false,
        hasWorkflow: false,
        hasMcp: false,
        hasHook: false,
      };
    case "full":
      return {
        entrypoints: { worker: worker.node, app: appEntrypoint() },
        integrations: [workflowIntegration(), ...fileTabIntegrations()],
        contentItems: [workflowContent()],
        nodeHandlers: ["hello", "preview-text", "surface.createSession"],
        nodeWorker: true,
        usesJsSdk: true,
        hasApp: true,
        hasSkill: false,
        hasWorkflow: true,
        hasMcp: false,
        hasHook: false,
      };
    case "ts-worker":
    case "node-worker":
      return {
        entrypoints: { worker: worker.node },
        integrations: [workflowIntegration()],
        contentItems: [workflowContent()],
        nodeHandlers: ["hello"],
        nodeWorker: true,
        usesJsSdk: true,
        hasApp: false,
        hasSkill: false,
        hasWorkflow: true,
        hasMcp: false,
        hasHook: false,
      };
    case "python-worker":
      return {
        entrypoints: { worker: worker.python },
        integrations: [workflowIntegration()],
        contentItems: [workflowContent()],
        nodeHandlers: null,
        nodeWorker: false,
        usesJsSdk: false,
        hasApp: false,
        hasSkill: false,
        hasWorkflow: true,
        hasMcp: false,
        hasHook: false,
      };
    case "rust-worker":
      return {
        entrypoints: { worker: worker.native },
        integrations: [workflowIntegration()],
        contentItems: [workflowContent()],
        nodeHandlers: null,
        nodeWorker: false,
        usesJsSdk: false,
        hasApp: false,
        hasSkill: false,
        hasWorkflow: true,
        hasMcp: false,
        hasHook: false,
      };
    case "host-service":
      return {
        entrypoints: { worker: worker.node },
        integrations: [
          {
            id: "tick",
            kind: "host.service",
            handler: "hello",
            intervalSeconds: 30,
          },
        ],
        contentItems: [],
        nodeHandlers: ["hello"],
        nodeWorker: true,
        usesJsSdk: true,
        hasApp: false,
        hasSkill: false,
        hasWorkflow: false,
        hasMcp: false,
        hasHook: false,
      };
    default: {
      const exhausted: never = template;
      throw new Error(`plugin_template_unknown: ${exhausted}`);
    }
  }
}

function nodeWorkerEntrypoint() {
  return {
    path: "dist/worker.mjs",
    runtime: "node" as const,
    protocol: "1.1" as const,
  };
}

function appEntrypoint() {
  return {
    root: "dist/app",
    document: "index.html",
    protocol: "1.0" as const,
  };
}

function skillIntegration() {
  return {
    id: "hello",
    kind: "content.skill",
    resource: "contents/skills/hello",
  };
}

function skillContent() {
  return {
    path: "contents/skills/hello/SKILL.md",
    kind: "skill",
    title: "Hello",
  };
}

function mcpIntegration() {
  return {
    id: "hello",
    kind: "content.mcp",
    resource: "contents/mcps/hello.json",
  };
}

function mcpContent() {
  return {
    path: "contents/mcps/hello.json",
    kind: "mcp",
    title: "Hello",
  };
}

function hookIntegration() {
  return {
    id: "before-prompt",
    kind: "content.hook",
    resource: "contents/hooks/before-prompt.md",
    event: "session.before_prompt",
  };
}

function hookContent() {
  return {
    path: "contents/hooks/before-prompt.md",
    kind: "hook",
    title: "Before prompt",
  };
}

function workflowIntegration() {
  return {
    id: "hello",
    kind: "workflow.binding",
    resource: "contents/workflows/hello/workflow.json",
  };
}

function workflowContent() {
  return {
    path: "contents/workflows/hello/workflow.json",
    kind: "workflow",
    title: "Hello",
  };
}

function fileTabIntegrations() {
  return [
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
  ];
}

function editorTabIntegrations() {
  return [
    {
      id: "notes",
      kind: "file.opener",
      label: "Notes",
      extensions: ["txt", "md"],
      editorSurface: "notes-editor",
    },
    {
      id: "notes-editor",
      kind: "app.surface",
      label: "Notes",
      slot: "artifact.editor",
      appEntrypoint: "app",
      handler: "surface.createSession",
      allowedMethods: ["hello"],
      minHeight: 320,
    },
  ];
}

async function writeSkill(root: string) {
  await mkdir(join(root, "contents", "skills", "hello"), { recursive: true });
  await writeFile(
    join(root, "contents", "skills", "hello", "SKILL.md"),
    `---\nname: hello\ndescription: Greet the user from this plugin.\n---\n# Hello\n\nUse this skill to greet the user.\n`,
  );
}

async function writeWorkflow(root: string) {
  await mkdir(join(root, "contents", "workflows", "hello"), {
    recursive: true,
  });
  await writeJson(join(root, "contents", "workflows", "hello", "workflow.json"), {
    label: "Hello",
    entrypoints: ["action", "command"],
    handler: "hello",
  });
}

async function writeManagedMcp(root: string) {
  await mkdir(join(root, "contents", "mcps"), { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "dist", "mcp"), { recursive: true });
  await writeJson(join(root, "contents", "mcps", "hello.json"), {
    managedRuntime: {
      source: "runtime/mcp.mjs",
      entrypoint: "dist/mcp/hello.mjs",
      protocolRevision: "2026-07-28",
      defaultBinding: "all-compatible-agents",
    },
  });
  const server =
    "process.stdout.write(JSON.stringify({ ready: true }) + '\\n');\n";
  await writeFile(join(root, "runtime", "mcp.mjs"), server);
  await writeFile(join(root, "dist", "mcp", "hello.mjs"), server);
}

async function writeHook(root: string) {
  await mkdir(join(root, "contents", "hooks"), { recursive: true });
  await writeFile(
    join(root, "contents", "hooks", "before-prompt.md"),
    "Follow this plugin's standing instructions before answering.\n",
  );
}

async function writeNodeWorker(
  root: string,
  template: PluginTemplate,
  spec: TemplateSpec,
) {
  await mkdir(join(root, "runtime"), { recursive: true });
  const definition = nodeWorkerSource(spec);
  const entry = `import { runStdioPluginWorker } from '@vibex/plugin-sdk/stdio';
import definition from './worker.mjs';

await runStdioPluginWorker(definition);
`;
  if (template === "ts-worker") {
    await writeFile(join(root, "runtime", "worker.ts"), definition);
    await writeFile(
      join(root, "runtime", "worker.mjs"),
      'export { default } from "./worker.ts";\n',
    );
    await writeFile(join(root, "runtime", "main.mjs"), entry);
    return;
  }
  await writeFile(join(root, "runtime", "worker.mjs"), definition);
  await writeFile(join(root, "runtime", "main.mjs"), entry);
}

function nodeWorkerSource(spec: TemplateSpec) {
  const handles = (spec.nodeHandlers ?? [])
    .map((handler) => {
      if (handler === "surface.createSession") {
        return "  plugin.handle('surface.createSession', async () => ({ ready: true }));";
      }
      if (handler === "preview-text") {
        return "  plugin.handle('preview-text', async (input) => ({ kind: 'text', input }));";
      }
      return "  plugin.handle('hello', async (input) => ({ message: 'Hello from VibeX', input }));";
    })
    .join("\n");
  return `import { definePluginWorker } from '@vibex/plugin-sdk/worker';\n\nexport default definePluginWorker((plugin) => {\n${handles}\n});\n`;
}

async function writeAppSurface(root: string) {
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "app.mjs"),
    `import { definePluginApp } from '@vibex/plugin-sdk/app';\nimport './app.css';\n\nexport default definePluginApp(({ root, bridge }) => {\n  const button = document.createElement('button');\n  button.textContent = 'Hello from VibeX';\n  button.addEventListener('click', () => void bridge.invoke('hello'));
  root.append(button);\n  bridge.ready();\n  return () => button.remove();\n});\n`,
  );
  await writeFile(
    join(root, "runtime", "app.css"),
    `:root { color-scheme: light dark; font: 13px system-ui, sans-serif; }\nbody { margin: 0; }\nbutton { font: inherit; }\n`,
  );
  await writeFile(
    join(root, "runtime", "app.html"),
    '<!doctype html><html><body><main id="app"></main><script type="module" src="./app.mjs"></script></body></html>\n',
  );
}

async function writePythonWorker(root: string, id: string) {
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "worker.py"),
    `from vibex_plugin import define_plugin_worker, run_stdio_plugin_worker


def setup(registrar, _environment):
    def hello(value, _env):
        return {"message": "Hello from VibeX", "input": value}

    registrar.handle("hello", hello)


if __name__ == "__main__":
    run_stdio_plugin_worker(define_plugin_worker(setup))
`,
  );
  await writeFile(
    join(root, "pyproject.toml"),
    `[project]
name = "${pythonProjectName(id)}"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["vibex-plugin>=1.0.0"]

[tool.vibex.plugin]
worker = "runtime/worker.py"
`,
  );
}

async function writeRustWorker(root: string, id: string) {
  await mkdir(join(root, "runtime", "src"), { recursive: true });
  await writeFile(
    join(root, "runtime", "Cargo.toml"),
    `[package]
name = "${rustCrateName(id)}"
version = "0.1.0"
edition = "2021"
rust-version = "1.85"

[dependencies]
serde_json = "1"
vibex-plugin-sdk = "1.0.0"
`,
  );
  await writeFile(
    join(root, "runtime", "src", "main.rs"),
    `use serde_json::json;
use vibex_plugin_sdk::{define_plugin_worker, run_stdio_plugin_worker_blocking};

fn main() {
    let definition = define_plugin_worker(|registrar, _env| {
        registrar.handle_sync("hello", |input, _env| {
            Ok(json!({
                "message": "Hello from VibeX",
                "input": input,
            }))
        });
    });
    if let Err(error) = run_stdio_plugin_worker_blocking(definition) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
`,
  );
}

async function writePluginTest(root: string, handlers: string[] | null) {
  await mkdir(join(root, "test"), { recursive: true });
  if (!handlers) {
    await writeFile(
      join(root, "test", "fixture.mjs"),
      `export const MANIFEST = ${JSON.stringify(
        JSON.parse(
          await (await import("node:fs/promises")).readFile(
            join(root, ".vibex-plugin", "plugin.json"),
            "utf8",
          ),
        ),
        null,
        2,
      )};
`,
    );
    await writeFile(
      join(root, "test", "plugin.test.mjs"),
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { MANIFEST } from './fixture.mjs';

test('plugin.json is a v4 manifest', () => {
  assert.equal(MANIFEST.manifestVersion, 4);
});
`,
    );
    return;
  }
  await writeFile(
    join(root, "test", "plugin.test.mjs"),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import definition from '../runtime/worker.mjs';
import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

test('registers every required Worker handler', async () => {
  const worker = await createWorkerHarness(definition);
  assert.deepEqual(worker.handlers, ${JSON.stringify([...handlers].sort())});
  await assert.rejects(() => worker.invoke('undeclared', null), /not registered/);
  await worker.dispose();
});
`,
  );
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rustCrateName(id: string) {
  const name = id.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(name) ? name : `plugin-${name || "worker"}`;
}

function pythonProjectName(id: string) {
  const name = id.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(name) ? name : `plugin-${name || "worker"}`;
}
