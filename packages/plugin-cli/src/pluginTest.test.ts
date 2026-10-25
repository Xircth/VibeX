import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scaffoldPlugin } from "./scaffold.js";
import { testPlugin } from "./pluginTest.js";

describe("plugin test runner", () => {
  it("builds and tests a clean scaffold without installing workspace dependencies", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-test-fixture-"));
    const root = await scaffoldPlugin(join(parent, "hello"), "fixture", "full");

    await expect(testPlugin(root)).resolves.toBeUndefined();
    await expect(
      readFile(join(root, "dist", "worker.mjs"), "utf8"),
    ).resolves.toContain("Hello from VibeX");
  });

  it("runs tests with the plugin root so relative plugin.json reads stay live", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-test-live-"));
    const root = await scaffoldPlugin(join(parent, "notes"), "fixture", "skill");
    const manifestPath = join(root, ".vibex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string;
    };
    manifest.name = "Live Notes";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(root, "test", "plugin.test.mjs"),
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('reads the live plugin.json next to the package', async () => {
  const root = process.env.VIBEX_PLUGIN_ROOT;
  assert.ok(root);
  const fromEnv = JSON.parse(
    await readFile(join(root, '.vibex-plugin/plugin.json'), 'utf8'),
  );
  const fromUrl = JSON.parse(
    await readFile(new URL('../.vibex-plugin/plugin.json', import.meta.url), 'utf8'),
  );
  assert.equal(fromEnv.manifestVersion, 4);
  assert.equal(fromEnv.name, 'Live Notes');
  assert.equal(fromUrl.name, 'Live Notes');
});
`,
    );

    await expect(testPlugin(root)).resolves.toBeUndefined();
    await expect(
      access(join(root, ".vibex-plugin", ".test-dist")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets a no-worker scaffold test the real plugin.json after init", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vibex-plugin-test-skill-"));
    const root = await scaffoldPlugin(join(parent, "skill"), "fixture", "skill");

    await expect(testPlugin(root)).resolves.toBeUndefined();
  });
});
