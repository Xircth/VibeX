import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPlugin } from "./build.js";
import { scaffoldPlugin } from "./scaffold.js";
import { validatePlugin } from "./validation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("clean-room App + Agent build", () => {
  it("builds its own scaffold into a self-contained surface document", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-build-"));
    roots.push(parent);
    const root = await scaffoldPlugin(
      join(parent, "hello-surface"),
      "cleanroom",
    );
    await writeFile(
      join(root, "runtime", "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await writeFile(
      join(root, "runtime", "app.css"),
      `:root { color-scheme: light dark; }\nmain { background-image: url('./pixel.png'); }\n`,
    );

    await buildPlugin(root);

    const validation = await validatePlugin(root);
    const html = await readFile(join(root, "dist/app/index.html"), "utf8");
    const manifest = JSON.parse(
      await readFile(join(root, ".vibex-plugin/plugin.json"), "utf8"),
    ) as { integrations: Array<{ kind: string }> };
    expect(validation.valid).toBe(true);
    expect(
      manifest.integrations.some(({ kind }) => kind === "app.surface"),
    ).toBe(true);
    expect(html).toContain('<script type="module">');
    expect(html).toContain("<style>");
    expect(html).toContain("color-scheme:light dark");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("vibexSurface");
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/iu);
    expect(html).not.toMatch(/<link\b[^>]*\bhref=/iu);
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain("plugin-platform-sdk");
  });

  it.each(["file-tab", "skill"] as const)(
    "builds and validates the %s template without undeclared surfaces",
    async (template) => {
      const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-template-"));
      roots.push(parent);
      const root = await scaffoldPlugin(
        join(parent, `${template}-plugin`),
        "cleanroom",
        template,
      );

      await buildPlugin(root);

      const validation = await validatePlugin(root);
      const manifest = JSON.parse(
        await readFile(join(root, ".vibex-plugin/plugin.json"), "utf8"),
      ) as {
        entrypoints?: { app?: unknown };
        integrations: Array<{ kind: string }>;
      };
      expect(validation.diagnostics).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(Boolean(manifest.entrypoints?.app)).toBe(template === "file-tab");
      expect(
        manifest.integrations.some(({ kind }) => kind === "app.surface"),
      ).toBe(template === "file-tab");
      expect(
        manifest.integrations.some(({ kind }) => kind === "content.skill"),
      ).toBe(template === "skill");
    },
  );

  it("bundles a protocol 2.0 app source to the declared entry", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-app20-"));
    roots.push(parent);
    const root = await scaffoldPlugin(join(parent, "v2-app"), "cleanroom", "skill");
    const manifestPath = join(root, ".vibex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      integrations?: unknown;
      entrypoints?: unknown;
    };
    manifest.integrations = [];
    manifest.entrypoints = {
      app: { entry: "dist/app/main.js", protocol: "2.0" },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(
      join(root, "runtime/app.tsx"),
      `export default function App() {
  return <p>Hello from protocol 2</p>;
}
`,
    );

    await buildPlugin(root);

    const bundled = await readFile(join(root, "dist/app/main.js"), "utf8");
    expect(bundled).toContain("Hello from protocol 2");
    expect(bundled).toMatch(/from\s*["']react\/jsx-runtime["']/);
    expect((await validatePlugin(root)).valid).toBe(true);
  });

  it("keeps an already-built protocol 2.0 app entry without a source tree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-app20-ready-"));
    roots.push(parent);
    const root = await scaffoldPlugin(
      join(parent, "prebuilt-app"),
      "cleanroom",
      "skill",
    );
    const manifestPath = join(root, ".vibex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      integrations?: unknown;
      entrypoints?: unknown;
    };
    manifest.integrations = [];
    manifest.entrypoints = {
      app: { entry: "app/main.js", protocol: "2.0" },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(
      join(root, "app/main.js"),
      "export default { activate() { return; } };\n",
    );

    await expect(buildPlugin(root)).resolves.toBeUndefined();
    expect(await readFile(join(root, "app/main.js"), "utf8")).toContain(
      "activate",
    );
    expect((await validatePlugin(root)).valid).toBe(true);
  });

  it("bundles a Host-managed MCP into its declared package entrypoint", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-mcp-"));
    roots.push(parent);
    const root = await scaffoldPlugin(join(parent, "managed-mcp"), "cleanroom");
    const manifestPath = join(root, ".vibex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      integrations: Array<Record<string, unknown>>;
    };
    manifest.integrations.push({
      id: "workflow-control",
      kind: "content.mcp",
      resource: "contents/mcps/workflow-control.json",
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await mkdir(join(root, "contents/mcps"), { recursive: true });
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(
      join(root, "contents/mcps/workflow-control.json"),
      JSON.stringify({
        managedRuntime: {
          source: "runtime/mcp.mjs",
          entrypoint: "dist/mcp/workflow-control.mjs",
          protocolRevision: "2026-07-28",
          defaultBinding: "all-compatible-agents",
        },
      }),
    );
    await writeFile(
      join(root, "runtime/mcp.mjs"),
      "process.stdout.write(JSON.stringify({ready: true}) + '\\n');\n",
    );

    await buildPlugin(root);

    const bundled = await readFile(
      join(root, "dist/mcp/workflow-control.mjs"),
      "utf8",
    );
    expect(bundled).toContain("ready");
    expect((await validatePlugin(root)).valid).toBe(true);
  });
});
