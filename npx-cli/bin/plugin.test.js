const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("vibex plugin pack creates a validated VXP package", () => {
  const root = mkdtempSync(join(tmpdir(), "vibex-cli-plugin-"));
  const output = join(root, "test.vxp");
  try {
    writeFixture(root);
    const result = spawnSync(
      process.execPath,
      [join(__dirname, "cli.js"), "plugin", "pack", root, "--output", output],
      {
        encoding: "utf8",
        env: { ...process.env, VIBEX_LOCAL: "1" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /test\.vxp\nsha256:[a-f0-9]{64}/u);
    assert.equal(existsSync(output), true);
    assert.equal(readFileSync(output).subarray(0, 2).toString("ascii"), "PK");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(__dirname, "..", "dist"), { recursive: true, force: true });
  }
});

function writeFixture(root) {
  mkdirSync(join(root, ".vibex-plugin"), { recursive: true });
  mkdirSync(join(root, "contents", "skills", "test"), { recursive: true });
  writeFileSync(
    join(root, ".vibex-plugin", "plugin.json"),
    JSON.stringify({
      manifestVersion: 4,
      apiVersion: "1.0",
      id: "test",
      publisher: "tests",
      version: "1.0.0",
      name: "Test",
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
      permissions: [],
      integrations: [
        {
          id: "test",
          kind: "content.skill",
          resource: "contents/skills/test",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, ".vibex-plugin", "content.index.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          path: "contents/skills/test/SKILL.md",
          kind: "skill",
          title: "Test skill",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "README.md"),
    "---\nsummary: Test the VibeX plugin pack command.\n---\n# Test\n",
  );
  writeFileSync(join(root, "config.json"), "{}\n");
  writeFileSync(
    join(root, "contents", "skills", "test", "SKILL.md"),
    "---\nname: test\ndescription: Test skill.\n---\n",
  );
}
