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

function resolveTargetTriple(env = process.env, hostTriple = rustcHost()) {
  return env.VIBEX_BUILD_TARGET || env.TAURI_ENV_TARGET_TRIPLE || hostTriple;
}

function resolveSidecarProfile(env = process.env) {
  if (env.CARGO_PROFILE) {
    return env.CARGO_PROFILE;
  }
  return env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
}

function resolveSidecarBinDir({
  repo,
  env = process.env,
  hostTriple,
} = {}) {
  const resolvedRepo = repo || path.resolve(__dirname, "..");
  const triple = resolveTargetTriple(env, hostTriple);
  const profile = resolveSidecarProfile(env);
  const targetDir = env.CARGO_TARGET_DIR || path.join(resolvedRepo, "target");
  return {
    triple,
    profile,
    binDir: path.join(targetDir, triple, profile),
  };
}

function sidecarBinsExist({
  repo,
  env = process.env,
  hostTriple,
  platform = process.platform,
} = {}) {
  const { binDir } = resolveSidecarBinDir({ repo, env, hostTriple });
  const ext = platform === "win32" ? ".exe" : "";
  return (
    fs.existsSync(path.join(binDir, `vibex-mcp${ext}`)) &&
    fs.existsSync(path.join(binDir, `vibex-workflow-mcp${ext}`))
  );
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

function main(env = process.env) {
  const repo = path.resolve(__dirname, "..");
  const { triple, binDir } = resolveSidecarBinDir({ repo, env });
  const sidecarDir = path.join(repo, "src-tauri", "binaries");
  copySidecar("vibex-mcp", path.join(binDir, "vibex-mcp"), sidecarDir, triple);
  copySidecar(
    "vibex-workflow-mcp",
    path.join(binDir, "vibex-workflow-mcp"),
    sidecarDir,
    triple,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  resolveSidecarBinDir,
  resolveTargetTriple,
  sidecarBinsExist,
};
