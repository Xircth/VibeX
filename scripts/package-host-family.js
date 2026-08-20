#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const options = {
    server: null,
    mcp: null,
    workflowMcp: null,
    web: null,
    plugins: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const name = key.slice(2) === "workflow-mcp" ? "workflowMcp" : key.slice(2);
    if (!(name in options)) {
      throw new Error(`unknown option: ${key}`);
    }
    options[name] = argv[index + 1];
    index += 1;
  }
  for (const [name, value] of Object.entries(options)) {
    if (!value) {
      throw new Error(`missing --${name}`);
    }
  }
  return options;
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'target', '.git'].includes(entry.name)) continue;
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function bundledPluginRoots(pluginsDir) {
  return fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsDir, entry.name))
    .filter((directory) =>
      fs.existsSync(path.join(directory, ".vibex-plugin", "plugin.json")),
    );
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function packageHostFamily(options) {
  const output = path.resolve(options.output);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const serverName = path.basename(options.server);
  const mcpName = path.basename(options.mcp);
  const workflowMcpName = path.basename(options.workflowMcp);
  copyFile(options.server, path.join(output, serverName));
  copyFile(options.mcp, path.join(output, mcpName));
  copyFile(options.workflowMcp, path.join(output, workflowMcpName));
  const workflowScript = path.join(
    path.dirname(options.plugins),
    "..",
    "packages",
    "vibex-workflow-mcp",
    "dist",
    "mcp",
    "workflow-control.mjs",
  );
  if (fs.existsSync(workflowScript)) {
    copyFile(workflowScript, path.join(output, "workflow-control.mjs"));
  }
  copyDirectory(options.web, path.join(output, "web"));
  const repoRoot = path.resolve(path.dirname(options.plugins), "..");
  const sdkRoot = path.join(repoRoot, "packages");
  if (fs.existsSync(sdkRoot)) {
    copyDirectory(path.join(sdkRoot, "plugin-contract"), path.join(output, "sdk", "plugin-contract"));
    copyDirectory(path.join(sdkRoot, "plugin-sdk"), path.join(output, "sdk", "js", "plugin-sdk"));
    copyDirectory(path.join(sdkRoot, "plugin-cli"), path.join(output, "sdk", "js", "plugin-cli"));
  }
  const pythonSdk = path.join(repoRoot, "sdk", "python");
  if (fs.existsSync(pythonSdk)) {
    copyDirectory(pythonSdk, path.join(output, "sdk", "python"));
  }
  const rustSdk = path.join(repoRoot, "crates", "plugin-sdk");
  if (fs.existsSync(rustSdk)) {
    copyDirectory(rustSdk, path.join(output, "sdk", "rust"));
  }
  const officialIndex = path.join(options.plugins, "index", "official.v1.json");
  if (fs.existsSync(officialIndex)) {
    copyFile(officialIndex, path.join(output, "plugins", "index", "official.v1.json"));
  }

  const bundled = path.join(output, "plugins", "bundled");
  for (const pluginRoot of bundledPluginRoots(options.plugins)) {
    copyDirectory(pluginRoot, path.join(bundled, path.basename(pluginRoot)));
  }

  const checksums = [
    serverName,
    mcpName,
    workflowMcpName,
    ...walkFiles(output)
      .map((filePath) => path.relative(output, filePath))
      .filter((relative) => relative !== "SHA256SUMS")
      .sort(),
  ].filter((relative, index, all) => all.indexOf(relative) === index);

  const lines = checksums.map((relative) => {
    const digest = sha256File(path.join(output, relative));
    return `${digest}  ${relative.replaceAll(path.sep, "/")}`;
  });
  fs.writeFileSync(path.join(output, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return output;
}

function walkFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function main() {
  const output = packageHostFamily(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { packageHostFamily, parseArgs, bundledPluginRoots };
