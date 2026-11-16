const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { packageHostFamily } = require("./package-host-family");

test("packages server, companion, web UI, and official catalog without plugin packages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-host-family-"));
  const server = path.join(root, "dimo-server");
  const mcp = path.join(root, "dimo-mcp");
  const workflowMcp = path.join(root, "dimo-workflow-mcp");
  fs.writeFileSync(server, "server-bin");
  fs.writeFileSync(mcp, "mcp-bin");
  fs.writeFileSync(workflowMcp, "workflow-mcp-bin");
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "index.html"), "<html></html>");
  fs.writeFileSync(
    path.join(root, "dimo-plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      marketplace: { origin: "https://vibex.xforever.xin", path: "/marketplace" },
      official: [
        {
          id: "dimo.session-enhance",
          repository: "https://github.com/DimoADE/Dimo-plugin-session-enhance",
        },
      ],
    }),
  );
  const plugin = path.join(root, "plugins", "session-enhance");
  fs.mkdirSync(path.join(plugin, ".dimo-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, ".dimo-plugin", "plugin.json"),
    JSON.stringify({ id: "dimo.session-enhance" }),
  );
  fs.mkdirSync(path.join(root, "plugins", "scratch"));
  fs.writeFileSync(path.join(root, "plugins", "scratch", "notes.txt"), "ignore");
  const sample = path.join(root, "plugins", "host-chrome");
  fs.mkdirSync(path.join(sample, ".dimo-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(sample, ".dimo-plugin", "plugin.json"),
    JSON.stringify({ id: "dimo.host-chrome" }),
  );

  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "claude-native-driver.mjs"),
    "export const driver = true;\n",
  );
  fs.writeFileSync(
    path.join(root, "scripts", "claude-native-events.mjs"),
    "export const events = true;\n",
  );
  fs.writeFileSync(
    path.join(root, "scripts", "claude-native-cli.mjs"),
    "export const cli = true;\n",
  );
  fs.writeFileSync(
    path.join(root, "scripts", "claude-native-models.mjs"),
    "export const models = true;\n",
  );
  fs.writeFileSync(
    path.join(root, "scripts", "claude-native-driver.test.mjs"),
    "// test should not be bundled\n",
  );

  const output = packageHostFamily({
    server,
    mcp,
    workflowMcp,
    web: path.join(root, "web"),
    plugins: path.join(root, "plugins"),
    output: path.join(root, "out"),
  });

  assert.equal(fs.readFileSync(path.join(output, "dimo-server"), "utf8"), "server-bin");
  assert.equal(fs.readFileSync(path.join(output, "dimo-mcp"), "utf8"), "mcp-bin");
  assert.equal(
    fs.readFileSync(path.join(output, "dimo-workflow-mcp"), "utf8"),
    "workflow-mcp-bin",
  );
  assert.equal(
    fs.readFileSync(path.join(output, "web", "index.html"), "utf8"),
    "<html></html>",
  );
  assert.equal(
    fs.readFileSync(path.join(output, "scripts", "claude-native-driver.mjs"), "utf8"),
    "export const driver = true;\n",
  );
  assert.equal(
    fs.readFileSync(path.join(output, "scripts", "claude-native-events.mjs"), "utf8"),
    "export const events = true;\n",
  );
  assert.equal(
    fs.readFileSync(path.join(output, "scripts", "claude-native-cli.mjs"), "utf8"),
    "export const cli = true;\n",
  );
  assert.equal(
    fs.readFileSync(path.join(output, "scripts", "claude-native-models.mjs"), "utf8"),
    "export const models = true;\n",
  );
  assert.equal(
    fs.existsSync(path.join(output, "scripts", "claude-native-driver.test.mjs")),
    false,
  );
  assert.ok(fs.existsSync(path.join(output, "dimo-plugin.json")));
  assert.equal(fs.existsSync(path.join(output, "plugins", "bundled")), false);
  assert.equal(
    fs.existsSync(path.join(output, "plugins", "bundled", "session-enhance")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(output, "plugins", "bundled", "host-chrome")),
    false,
  );

  const checksums = fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8");
  assert.match(checksums, /  dimo-server\n/);
  assert.match(checksums, /  dimo-mcp\n/);
  assert.match(checksums, /  dimo-workflow-mcp\n/);
  assert.match(checksums, /  web\/index\.html\n/);
  assert.match(checksums, /  scripts\/claude-native-driver\.mjs\n/);
  assert.match(checksums, /  scripts\/claude-native-events\.mjs\n/);
  assert.match(checksums, /  scripts\/claude-native-cli\.mjs\n/);
  assert.match(checksums, /  scripts\/claude-native-models\.mjs\n/);
  assert.doesNotMatch(checksums, /claude-native-driver\.test\.mjs/);
  assert.doesNotMatch(checksums, /scratch/);
});
