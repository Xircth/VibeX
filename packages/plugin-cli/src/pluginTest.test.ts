import { mkdtemp, readFile } from "node:fs/promises";
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
});
