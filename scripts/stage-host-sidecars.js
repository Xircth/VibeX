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
    nativeBinDir: path.join(targetDir, profile),
  };
}

function sidecarFileName(name, platform = process.platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

function isBuiltSidecar(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function sidecarBinsExist({
  repo,
  env = process.env,
  hostTriple,
  platform = process.platform,
} = {}) {
  const { binDir, nativeBinDir } = resolveSidecarBinDir({
    repo,
    env,
    hostTriple,
  });
  return ["vibex-mcp", "vibex-workflow-mcp"].every((name) => {
    const file = sidecarFileName(name, platform);
    return (
      isBuiltSidecar(path.join(binDir, file)) ||
      isBuiltSidecar(path.join(nativeBinDir, file))
    );
  });
}

function resolveSidecarSource(name, binDir, nativeBinDir, platform = process.platform) {
  const file = sidecarFileName(name, platform);
  const triplePath = path.join(binDir, file);
  if (isBuiltSidecar(triplePath)) {
    return triplePath;
  }
  const nativePath = path.join(nativeBinDir, file);
  if (isBuiltSidecar(nativePath)) {
    return nativePath;
  }
  throw new Error(`missing or empty sidecar ${triplePath}`);
}

function copySidecar(name, sourcePath, destinationDir, triple) {
  if (!isBuiltSidecar(sourcePath)) {
    throw new Error(`missing or empty sidecar ${sourcePath}`);
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  fs.mkdirSync(destinationDir, { recursive: true });
  const to = path.join(destinationDir, `${name}-${triple}${ext}`);
  fs.copyFileSync(sourcePath, to);
  if (process.platform !== "win32") {
    fs.chmodSync(to, 0o755);
  }
  if (!isBuiltSidecar(to)) {
    throw new Error(`staged sidecar is empty: ${to}`);
  }
}

function main(env = process.env) {
  const repo = path.resolve(__dirname, "..");
  const { triple, binDir, nativeBinDir } = resolveSidecarBinDir({ repo, env });
  const sidecarDir = path.join(repo, "src-tauri", "binaries");
  copySidecar(
    "vibex-mcp",
    resolveSidecarSource("vibex-mcp", binDir, nativeBinDir),
    sidecarDir,
    triple,
  );
  copySidecar(
    "vibex-workflow-mcp",
    resolveSidecarSource("vibex-workflow-mcp", binDir, nativeBinDir),
    sidecarDir,
    triple,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  copySidecar,
  isBuiltSidecar,
  resolveSidecarBinDir,
  resolveSidecarSource,
  resolveTargetTriple,
  sidecarBinsExist,
};
