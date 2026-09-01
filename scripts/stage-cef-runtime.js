#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const workspaceRoot = path.join(__dirname, "..");

function isDebugBuild(env = process.env) {
  return env.TAURI_ENV_DEBUG === "true";
}

function cargoTarget(env = process.env) {
  return env.VIBEX_BUILD_TARGET || env.TAURI_ENV_TARGET_TRIPLE || null;
}

function cargoProfile(debug) {
  return debug ? "debug" : "release";
}

function cargoProfileArgs(debug) {
  return debug ? [] : ["--release"];
}

function cargoTargetArgs(target) {
  return target ? ["--target", target] : [];
}

function helperBuildArgs({ debug, target }) {
  return [
    "build",
    "-p",
    "vibex",
    "--bin",
    "vibex_cef_helper",
    ...cargoTargetArgs(target),
    ...cargoProfileArgs(debug),
  ];
}

function stagerBuildArgs({ debug, target }) {
  return [
    "build",
    "-p",
    "browser-cef",
    "--features",
    "cef-host",
    "--bin",
    "stage_cef_runtime",
    ...cargoTargetArgs(target),
    ...cargoProfileArgs(debug),
  ];
}

function resolveProfileBin({
  targetRoot,
  target,
  profile,
  name,
  platform = process.platform,
}) {
  const ext = platform === "win32" ? ".exe" : "";
  return path.join(
    targetRoot,
    ...(target ? [target] : []),
    profile,
    `${name}${ext}`,
  );
}

function runCargo(args, env = process.env) {
  const cargo = env.CARGO || "cargo";
  const result = spawnSync(cargo, args, {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCompiledBin(binPath, args, env = process.env) {
  if (!fs.existsSync(binPath)) {
    throw new Error(`missing binary ${binPath}`);
  }
  const result = spawnSync(binPath, args, {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function stageCefRuntime(env = process.env) {
  const debug = isDebugBuild(env);
  const profile = cargoProfile(debug);
  const target = cargoTarget(env);
  const targetRoot = env.CARGO_TARGET_DIR || path.join(workspaceRoot, "target");

  runCargo(helperBuildArgs({ debug, target }), env);
  runCargo(stagerBuildArgs({ debug, target }), env);
  runCompiledBin(
    resolveProfileBin({
      targetRoot,
      target,
      profile,
      name: "stage_cef_runtime",
    }),
    [profile],
    env,
  );

  const helperSource = resolveProfileBin({
    targetRoot,
    target,
    profile,
    name: "vibex_cef_helper",
  });
  const helperDestDir = path.join(targetRoot, "cef-runtime", process.platform);
  if (fs.existsSync(helperSource)) {
    fs.mkdirSync(helperDestDir, { recursive: true });
    fs.copyFileSync(
      helperSource,
      path.join(helperDestDir, path.basename(helperSource)),
    );
  }
}

module.exports = {
  helperBuildArgs,
  stagerBuildArgs,
  resolveProfileBin,
  cargoTarget,
  isDebugBuild,
  stageCefRuntime,
};

if (require.main === module) {
  stageCefRuntime();
}
