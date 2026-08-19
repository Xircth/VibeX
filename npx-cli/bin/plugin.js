const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HELP = `Usage: vibex plugin pack [dir] [--output file.vxp]`;

async function run(args) {
  const [command = "help", ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command !== "pack")
    throw new Error(`Unknown plugin command: ${command}\n${HELP}`);

  const root = path.resolve(positional(rest) || ".");
  const { validatePlugin } = await load("validation.js");
  const validation = await validatePlugin(root);
  if (!validation.valid) {
    const diagnostics = validation.diagnostics
      .map((item) => `${item.code}: ${item.message}`)
      .join("\n");
    throw new Error(`Plugin validation failed\n${diagnostics}`);
  }

  const { packPlugin } = await load("package.js");
  const result = await packPlugin(root, flag(rest, "--output"));
  process.stdout.write(
    `${result.output}\nsha256:${result.lock.packageDigest}\n`,
  );
}

async function load(file) {
  const bundled = path.join(__dirname, "..", "plugin-cli", file);
  const local = path.join(
    __dirname,
    "..",
    "..",
    "packages",
    "plugin-cli",
    "dist",
    file,
  );
  const modulePath = fs.existsSync(bundled) ? bundled : local;
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      "VibeX Plugin CLI is unavailable; reinstall or update VibeX.",
    );
  }
  return import(pathToFileURL(modulePath).href);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) return args[index];
  }
  return undefined;
}

module.exports = { run };
