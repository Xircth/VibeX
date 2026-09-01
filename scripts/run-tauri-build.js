#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { withNativeBuildEnv } = require("./cargo-path");
const { applyLocalEnvFile } = require("./load-local-env");
const {
  macosTauriBundles,
  macosWantsDmg,
  withoutAppleNotaryEnv,
} = require("./macos-notarize-and-dmg");

const workspaceRoot = path.join(__dirname, "..");
const sqlxOfflineDir = path.join(workspaceRoot, "crates", "db", ".sqlx");
const localEnv = applyLocalEnvFile(
  path.join(workspaceRoot, ".env.local"),
  process.env,
);

function runCommand(command, args, options = {}) {
  if (process.platform === "win32") {
    return spawn(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", command, ...args],
      { ...options, windowsHide: true },
    );
  }

  return spawn(command, args, options);
}

function hasBundleArg(args) {
  return args.some(
    (arg) =>
      arg === "--bundles" || arg === "-b" || arg.startsWith("--bundles="),
  );
}

function hasConfigArg(args) {
  return args.some(
    (arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="),
  );
}

function getTarget(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      return args[index + 1] || null;
    }
    if (arg.startsWith("--target=")) {
      return arg.slice("--target=".length) || null;
    }
  }
  return null;
}

function getBundlesArg(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--bundles" || arg === "-b") {
      return args[index + 1] || null;
    }
    if (arg.startsWith("--bundles=")) {
      return arg.slice("--bundles=".length) || null;
    }
  }
  return null;
}

function replaceBundlesArg(args, nextBundles) {
  const next = [];
  let replaced = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--bundles" || arg === "-b") {
      next.push(arg, nextBundles);
      index += 1;
      replaced = true;
      continue;
    }
    if (arg.startsWith("--bundles=")) {
      next.push(`--bundles=${nextBundles}`);
      replaced = true;
      continue;
    }
    next.push(arg);
  }
  if (!replaced) {
    next.unshift("--bundles", nextBundles);
  }
  return next;
}

function getDefaultBundles(platform) {
  switch (platform) {
    case "win32":
      return "nsis";
    case "darwin":
      return "app,dmg";
    case "linux":
      return "appimage";
    default:
      return null;
  }
}

function withTauriBuildEnv(env, target) {
  return {
    ...withNativeBuildEnv(env),
    SQLX_OFFLINE: env.SQLX_OFFLINE || "true",
    SQLX_OFFLINE_DIR: env.SQLX_OFFLINE_DIR || sqlxOfflineDir,
    CEF_PATH: env.CEF_PATH || path.join(workspaceRoot, ".cef"),
    ...(target ? { VIBEX_BUILD_TARGET: target } : {}),
  };
}

function withCefHelperCargoArgs(args) {
  const helperArgs = ["--bin", "vibex_cef_helper"];
  const separator = args.indexOf("--");
  if (separator === -1) {
    return [...args, "--", ...helperArgs];
  }
  const cargoArgs = args.slice(separator + 1);
  if (
    cargoArgs.some(
      (arg, index) =>
        arg === "--bin" && cargoArgs[index + 1] === "vibex_cef_helper",
    )
  ) {
    return args;
  }
  return [...args.slice(0, separator + 1), ...cargoArgs, ...helperArgs];
}

const userArgs = process.argv
  .slice(2)
  .filter((arg, index) => !(index === 0 && arg === "--"));
const defaultBundles = getDefaultBundles(process.platform);
const target = getTarget(userArgs);
const requestedBundles = getBundlesArg(userArgs) || defaultBundles;
const darwinDmgRequested =
  process.platform === "darwin" && macosWantsDmg(requestedBundles);

let resolvedUserArgs = userArgs;
let bundleArgs = [];
if (darwinDmgRequested) {
  const tauriBundles = macosTauriBundles(requestedBundles);
  if (hasBundleArg(userArgs)) {
    resolvedUserArgs = replaceBundlesArg(userArgs, tauriBundles);
  } else {
    bundleArgs = ["--bundles", tauriBundles];
  }
} else if (defaultBundles && !hasBundleArg(userArgs)) {
  bundleArgs = ["--bundles", defaultBundles];
}

const releaseConfig = process.env.VIBEX_TAURI_RELEASE_CONFIG;
const configArgs =
  releaseConfig && !hasConfigArg(userArgs) ? ["--config", releaseConfig] : [];
const buildArgs = withCefHelperCargoArgs([
  "exec",
  "tauri",
  "build",
  ...bundleArgs,
  ...configArgs,
  ...resolvedUserArgs,
]);
const buildEnv = withTauriBuildEnv(localEnv, target);
const tauriEnv = withoutAppleNotaryEnv(buildEnv);

if (bundleArgs.length > 0) {
  console.log(
    `Using Tauri bundles for ${process.platform}: ${bundleArgs[1]}`,
  );
}
if (darwinDmgRequested) {
  console.log(
    "Signing the app with Tauri, then notarizing and building the DMG with scripts/macos-notarize-and-dmg.js",
  );
}

const child = runCommand("pnpm", buildArgs, {
  env: tauriEnv,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error("Failed to start Tauri build:", error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code === 0) {
    if (darwinDmgRequested) {
      const script = path.join(__dirname, "macos-notarize-and-dmg.js");
      const extraArgs = target ? ["--target", target] : [];
      const result = spawnSync(process.execPath, [script, ...extraArgs], {
        env: buildEnv,
        stdio: "inherit",
      });
      if (result.error) {
        console.error("Failed to notarize or create the DMG:", result.error.message);
        process.exit(1);
      }
      if (result.status !== 0) {
        process.exit(result.status ?? 1);
      }
    }
    process.exit(0);
  }

  const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  console.error(`Tauri build exited with ${status}.`);
  process.exit(code ?? 1);
});
