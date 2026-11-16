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
  return env.DIMO_BUILD_TARGET || env.TAURI_ENV_TARGET_TRIPLE || hostTriple;
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
  return ["dimo-mcp", "dimo-workflow-mcp"].every((name) => {
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

function sweepRetiredStagedSidecars(destinationDir, baseFileName) {
  let entries;
  try {
    entries = fs.readdirSync(destinationDir);
  } catch {
    return;
  }
  const oldPrefix = `${baseFileName}.old-`;
  const tmpPrefix = `${baseFileName}.tmp-`;
  for (const entry of entries) {
    if (entry.startsWith(oldPrefix) || entry.startsWith(tmpPrefix)) {
      try {
        fs.unlinkSync(path.join(destinationDir, entry));
      } catch {
        // Still mapped on Windows; leave for a later sweep.
      }
    }
  }
}

function copySidecar(name, sourcePath, destinationDir, triple) {
  if (!isBuiltSidecar(sourcePath)) {
    throw new Error(`missing or empty sidecar ${sourcePath}`);
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  fs.mkdirSync(destinationDir, { recursive: true });
  const baseFileName = `${name}-${triple}${ext}`;
  sweepRetiredStagedSidecars(destinationDir, baseFileName);

  const to = path.join(destinationDir, baseFileName);
  const tmp = path.join(
    destinationDir,
    `${baseFileName}.tmp-${process.pid}-${Date.now()}`
  );
  fs.copyFileSync(sourcePath, tmp);
  if (process.platform !== "win32") {
    fs.chmodSync(tmp, 0o755);
  }

  try {
    fs.renameSync(tmp, to);
  } catch (error) {
    if (fs.existsSync(to)) {
      try {
        fs.renameSync(
          to,
          path.join(
            destinationDir,
            `${baseFileName}.old-${process.pid}-${Date.now()}`
          )
        );
        fs.renameSync(tmp, to);
      } catch (retryError) {
        fs.rmSync(tmp, { force: true });
        throw retryError;
      }
    } else {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
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
    "dimo-mcp",
    resolveSidecarSource("dimo-mcp", binDir, nativeBinDir),
    sidecarDir,
    triple,
  );
  copySidecar(
    "dimo-workflow-mcp",
    resolveSidecarSource("dimo-workflow-mcp", binDir, nativeBinDir),
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
