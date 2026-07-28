#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

const workspaceRoot = path.join(__dirname, "..");
const cargo = process.env.CARGO || "cargo";
const debug = process.env.TAURI_ENV_DEBUG === "true";
const profile = debug ? "debug" : "release";
const profileArgs = debug ? [] : ["--release"];
const target =
  process.env.VIBEX_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE;
const targetArgs = target ? ["--target", target] : [];

function run(args) {
  const result = spawnSync(cargo, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.platform === "darwin") {
  run([
    "build",
    "-p",
    "vibex",
    "--bin",
    "vibex_cef_helper",
    ...targetArgs,
    ...profileArgs,
  ]);
}

run([
  "run",
  "-p",
  "browser-cef",
  "--features",
  "cef-host",
  "--bin",
  "stage_cef_runtime",
  ...targetArgs,
  "--",
  profile,
]);
