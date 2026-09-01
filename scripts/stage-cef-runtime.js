#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
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

run([
  "build",
  "-p",
  "vibex",
  "--bin",
  "vibex_cef_helper",
  ...targetArgs,
  ...profileArgs,
]);

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

const helperName =
  process.platform === "win32" ? "vibex_cef_helper.exe" : "vibex_cef_helper";
const helperSource = path.join(
  process.env.CARGO_TARGET_DIR || path.join(workspaceRoot, "target"),
  ...(process.env.VIBEX_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE
    ? [process.env.VIBEX_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE]
    : []),
  profile,
  helperName
);
const helperDestDir = path.join(
  process.env.CARGO_TARGET_DIR || path.join(workspaceRoot, "target"),
  "cef-runtime",
  process.platform
);
if (fs.existsSync(helperSource)) {
  fs.mkdirSync(helperDestDir, { recursive: true });
  fs.copyFileSync(helperSource, path.join(helperDestDir, helperName));
}
