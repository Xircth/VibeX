#!/usr/bin/env node

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function rustcHost() {
  const output = execSync("rustc -vV", { encoding: "utf8" });
  const match = output.match(/^host: (\S+)$/m);
  if (!match) {
    throw new Error("could not read rustc host triple");
  }
  return match[1];
}

function copySidecar(name, source, destinationDir, triple) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const from = `${source}${ext}`;
  if (!fs.existsSync(from)) {
    throw new Error(`missing sidecar ${from}`);
  }
  fs.mkdirSync(destinationDir, { recursive: true });
  const to = path.join(destinationDir, `${name}-${triple}${ext}`);
  fs.copyFileSync(from, to);
  if (process.platform !== "win32") {
    fs.chmodSync(to, 0o755);
  }
}

function main() {
  const repo = path.resolve(__dirname, "..");
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE || rustcHost();
  const profile = process.env.CARGO_PROFILE || "release";
  const targetDir = process.env.CARGO_TARGET_DIR || path.join(repo, "target");
  const binDir = path.join(targetDir, profile);
  const sidecarDir = path.join(repo, "src-tauri", "binaries");
  copySidecar("vibex-mcp", path.join(binDir, "vibex-mcp"), sidecarDir, triple);
  copySidecar(
    "vibex-workflow-mcp",
    path.join(binDir, "vibex-workflow-mcp"),
    sidecarDir, triple,
  );
}

if (require.main === module) {
  main();
}

module.exports = { main };
