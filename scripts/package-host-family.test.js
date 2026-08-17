const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { packageHostFamily } = require("./package-host-family");

test("packages server, companion, web UI, and bundled plugins with checksums", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-host-family-"));
  const server = path.join(root, "vibex-server");
  const mcp = path.join(root, "vibex-mcp");
  fs.writeFileSync(server, "server-bin");
  fs.writeFileSync(mcp, "mcp-bin");
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "index.html"), "<html></html>");
  const plugin = path.join(root, "plugins", "multi-agent");
  fs.mkdirSync(path.join(plugin, ".vibex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, ".vibex-plugin", "plugin.json"),
    JSON.stringify({ id: "vibex.multi-agent" }),
  );
  fs.mkdirSync(path.join(root, "plugins", "scratch"));
  fs.writeFileSync(path.join(root, "plugins", "scratch", "notes.txt"), "ignore");

  const output = packageHostFamily({
    server,
    mcp,
    web: path.join(root, "web"),
    plugins: path.join(root, "plugins"),
    output: path.join(root, "out"),
  });

  assert.equal(fs.readFileSync(path.join(output, "vibex-server"), "utf8"), "server-bin");
  assert.equal(fs.readFileSync(path.join(output, "vibex-mcp"), "utf8"), "mcp-bin");
  assert.equal(
    fs.readFileSync(path.join(output, "web", "index.html"), "utf8"),
    "<html></html>",
  );
  assert.ok(
    fs.existsSync(
      path.join(output, "plugins", "bundled", "multi-agent", ".vibex-plugin", "plugin.json"),
    ),
  );
  assert.equal(fs.existsSync(path.join(output, "plugins", "bundled", "scratch")), false);

  const checksums = fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8");
  assert.match(checksums, /  vibex-server\n/);
  assert.match(checksums, /  vibex-mcp\n/);
  assert.match(checksums, /  web\/index.html\n/);
  assert.doesNotMatch(checksums, /scratch/);
});
