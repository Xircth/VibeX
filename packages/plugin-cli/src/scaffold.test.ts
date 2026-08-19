import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_TEMPLATES,
  scaffoldPlugin,
  type PluginTemplate,
} from "./scaffold.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("scaffoldPlugin templates", () => {
  it.each(PLUGIN_TEMPLATES)(
    "writes plugin.json for the %s template",
    async (template) => {
      const root = await scaffold(template);
      await expect(
        access(join(root, ".vibex-plugin", "plugin.json")),
      ).resolves.toBeUndefined();
    },
  );

  it("defaults to the full template", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-default-"));
    roots.push(parent);
    const implicit = await scaffoldPlugin(join(parent, "implicit"), "local");
    const explicit = await scaffoldPlugin(
      join(parent, "explicit"),
      "local",
      "full",
    );

    expect(await manifest(implicit)).toMatchObject({
      manifestVersion: 4,
      entrypoints: {
        worker: { runtime: "node", protocol: "1.1" },
        app: { protocol: "1.0" },
      },
      integrations: expect.arrayContaining([
        expect.objectContaining({ kind: "workflow.binding" }),
        expect.objectContaining({ kind: "file.opener" }),
        expect.objectContaining({ kind: "artifact.preview" }),
        expect.objectContaining({ kind: "app.surface" }),
      ]),
    });
    expect((await manifest(implicit)).integrations).toEqual(
      (await manifest(explicit)).integrations,
    );
  });

  it("rejects unknown templates including agent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-unknown-"));
    roots.push(parent);

    await expect(
      scaffoldPlugin(join(parent, "unknown"), "local", "agent"),
    ).rejects.toThrow("plugin_template_unknown: agent");
    await expect(
      scaffoldPlugin(join(parent, "legacy-app"), "local", "app"),
    ).rejects.toThrow("plugin_template_unknown: app");
  });

  it("declares a protocol 1.1 worker when a Worker exists", async () => {
    const expected: Record<
      Extract<
        PluginTemplate,
        | "full"
        | "file-tab"
        | "ts-worker"
        | "node-worker"
        | "python-worker"
        | "rust-worker"
        | "host-service"
      >,
      "node" | "python" | "native"
    > = {
      full: "node",
      "file-tab": "node",
      "ts-worker": "node",
      "node-worker": "node",
      "python-worker": "python",
      "rust-worker": "native",
      "host-service": "node",
    };

    for (const [template, runtime] of Object.entries(expected)) {
      const root = await scaffold(template as PluginTemplate);
      expect((await manifest(root)).entrypoints?.worker).toEqual({
        path: expect.any(String),
        runtime,
        protocol: "1.1",
      });
    }
  });

  it("keeps App surfaces on protocol 1.0", async () => {
    for (const template of ["full", "file-tab"] as const) {
      const root = await scaffold(template);
      expect((await manifest(root)).entrypoints?.app).toEqual({
        root: "dist/app",
        document: "index.html",
        protocol: "1.0",
      });
    }
  });

  it("scaffolds each specialized integration contract", async () => {
    const skill = await manifest(await scaffold("skill"));
    expect(skill.entrypoints?.worker).toBeUndefined();
    expect(skill.integrations).toEqual([
      expect.objectContaining({ kind: "content.skill" }),
    ]);

    const mcpRoot = await scaffold("mcp");
    const mcp = await manifest(mcpRoot);
    const hello = JSON.parse(
      await readFile(join(mcpRoot, "contents", "mcps", "hello.json"), "utf8"),
    ) as { managedRuntime: { entrypoint: string } };
    expect(mcp.integrations).toEqual([
      expect.objectContaining({ kind: "content.mcp" }),
    ]);
    expect(hello.managedRuntime.entrypoint).toBe("dist/mcp/hello.mjs");

    const fileTab = await manifest(await scaffold("file-tab"));
    expect(fileTab.integrations.map((item) => item.kind)).toEqual([
      "file.opener",
      "artifact.preview",
      "app.surface",
    ]);

    const host = await manifest(await scaffold("host-service"));
    expect(host.integrations).toEqual([
      expect.objectContaining({ kind: "host.service" }),
    ]);

    const hooks = await manifest(await scaffold("hooks"));
    expect(hooks.integrations).toEqual([
      expect.objectContaining({ kind: "content.hook" }),
    ]);

    const python = await scaffold("python-worker");
    await expect(readFile(join(python, "runtime", "worker.py"), "utf8")).resolves.toContain(
      "from vibex_plugin import define_plugin_worker",
    );

    const rust = await scaffold("rust-worker");
    await expect(
      readFile(join(rust, "runtime", "Cargo.toml"), "utf8"),
    ).resolves.toContain("vibex-plugin-sdk");
    await expect(
      readFile(join(rust, "runtime", "src", "main.rs"), "utf8"),
    ).resolves.toContain("define_plugin_worker");
  });
});

async function scaffold(template: PluginTemplate) {
  const parent = await mkdtemp(join(tmpdir(), `vibex-plugin-${template}-`));
  roots.push(parent);
  return scaffoldPlugin(join(parent, `${template}-plugin`), "local", template);
}

async function manifest(root: string) {
  return JSON.parse(
    await readFile(join(root, ".vibex-plugin", "plugin.json"), "utf8"),
  ) as {
    manifestVersion: number;
    entrypoints?: {
      worker?: { path: string; runtime: string; protocol: string };
      app?: { root: string; document: string; protocol: string };
    };
    integrations: Array<{ kind: string }>;
  };
}
