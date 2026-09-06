import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectLinkedPackage } from "./pluginControl.js";

describe("plugin Host control commands", () => {
  it("canonicalizes and inspects a validated linked package", async () => {
    const root = await fixture();
    const plugin = await inspectLinkedPackage(root);
    expect(plugin.root).toBe(await realpath(root));
    expect(plugin.identity).toEqual({ publisher: "tests", id: "notes" });
    expect(plugin.packageDigest).toMatch(/^[a-f0-9]{64}$/);
    const manifest = JSON.parse(
      await readFile(join(root, ".vibex-plugin", "plugin.json"), "utf8"),
    ) as { version: string };
    expect(plugin.manifest.version).toBe(manifest.version);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vibex-plugin-control-"));
  await mkdir(join(root, ".vibex-plugin"), { recursive: true });
  await mkdir(join(root, "contents", "workflows", "notes"), {
    recursive: true,
  });
  await writeFile(
    join(root, "README.md"),
    "---\nsummary: Take structured notes from any Agent task.\n---\n# Notes\n",
  );
  await writeFile(join(root, "config.json"), "{}\n");
  await writeFile(
    join(root, "contents", "workflows", "notes", "workflow.json"),
    '{"label":"Notes","entrypoints":["action"],"promptBlocks":[{"type":"text","text":"Take notes."}]}\n',
  );
  await writeFile(
    join(root, ".vibex-plugin", "content.index.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          path: "contents/workflows/notes/workflow.json",
          kind: "workflow",
          title: "Notes",
        },
      ],
    }),
  );
  await writeFile(
    join(root, ".vibex-plugin", "plugin.json"),
    JSON.stringify({
      manifestVersion: 4,
      apiVersion: "1.0",
      id: "notes",
      publisher: "tests",
      version: "1.0.0",
      name: "Notes",
      readme: "README.md",
      engines: { vibex: ">=0.1.3", pluginSdk: "^1.0.0" },
      content: {
        root: "contents",
        index: ".vibex-plugin/content.index.json",
      },
      config: {
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
      permissions: [],
      integrations: [
        {
          id: "notes",
          kind: "workflow.binding",
          resource: "contents/workflows/notes/workflow.json",
        },
      ],
    }),
  );
  return root;
}
