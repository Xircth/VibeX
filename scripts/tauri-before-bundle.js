#!/usr/bin/env node

const { execSync, spawnSync } = require("child_process");
const path = require("path");

const workspaceRoot = path.join(__dirname, "..");

function isDebugBuild(env = process.env) {
  return env.TAURI_ENV_DEBUG === "true";
}

function cargoTarget(env = process.env) {
  return env.VIBEX_BUILD_TARGET || env.TAURI_ENV_TARGET_TRIPLE || null;
}

function rustcHost() {
  const output = execSync("rustc -vV", { encoding: "utf8" });
  const match = output.match(/^host: (\S+)$/m);
  if (!match) {
    throw new Error("could not read rustc host triple");
  }
  return match[1];
}

function sidecarBuildArgs({ debug, target }) {
  const args = ["build", "-p", "vibex-mcp", "-p", "vibex-workflow-mcp"];
  if (!debug) {
    args.push("--release");
  }
  if (target) {
    args.push("--target", target);
  }
  return args;
}

function run(command, args, env) {
  const isWindows = process.platform === "win32";
  const result = isWindows
    ? spawnSync(env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args], {
        cwd: workspaceRoot,
        env,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawnSync(command, args, {
        cwd: workspaceRoot,
        env,
        stdio: "inherit",
      });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main(env = process.env) {
  const debug = isDebugBuild(env);
  const target = cargoTarget(env) || rustcHost();
  const profile = debug ? "debug" : "release";
  const nextEnv = {
    ...env,
    CARGO_PROFILE: env.CARGO_PROFILE || profile,
    VIBEX_BUILD_TARGET: env.VIBEX_BUILD_TARGET || target,
    TAURI_ENV_TARGET_TRIPLE: env.TAURI_ENV_TARGET_TRIPLE || target,
  };

  run(process.execPath, [path.join(__dirname, "stage-cef-runtime.js")], nextEnv);
  run(nextEnv.CARGO || "cargo", sidecarBuildArgs({ debug, target }), nextEnv);
  run(
    process.execPath,
    [path.join(__dirname, "stage-host-sidecars.js")],
    nextEnv,
  );
}

module.exports = { sidecarBuildArgs, isDebugBuild, cargoTarget };

if (require.main === module) {
  main();
}
