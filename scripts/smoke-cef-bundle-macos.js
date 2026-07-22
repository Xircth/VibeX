#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const path = require("path");

if (process.platform !== "darwin") {
  console.error(
    "The native CEF bundle smoke harness currently requires macOS.",
  );
  process.exit(2);
}

const workspaceRoot = path.join(__dirname, "..");
const skipBuild = process.argv.includes("--skip-build");
const appBundle = path.join(
  workspaceRoot,
  "target",
  "debug",
  "bundle",
  "macos",
  "VibeX.app",
);
const executable = path.join(appBundle, "Contents", "MacOS", "vibex");
const smokeConfig = JSON.stringify({
  identifier: "com.vibex.cef-smoke",
  build: skipBuild ? { beforeBuildCommand: null } : {},
  bundle: {
    createUpdaterArtifacts: false,
    macOS: {
      signingIdentity: "-",
      entitlements: "cef-smoke.entitlements.plist",
    },
  },
});

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processList() {
  return spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  }).stdout;
}

async function stopProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  await delay(500);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

async function main() {
  if (!skipBuild) {
    run("pnpm", [
      "exec",
      "tauri",
      "build",
      "--debug",
      "--bundles",
      "app",
      "--config",
      smokeConfig,
    ]);
  }
  run("codesign", ["--verify", "--deep", "--strict", appBundle]);

  const child = spawn(executable, [], {
    cwd: workspaceRoot,
    detached: true,
    env: { ...process.env, RUST_LOG: "browser_cef=debug,vibex=info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`VibeX exited before CEF initialized.\n${output}`);
      }
      const processes = processList();
      if (
        processes.includes(`${appBundle}/Contents/Frameworks/`) &&
        processes.includes("vibex Helper") &&
        processes.includes("--type=gpu-process")
      ) {
        console.log(
          "CEF bundle smoke passed: signed app and GPU subprocess started.",
        );
        return;
      }
      await delay(250);
    }
    throw new Error(
      `CEF GPU subprocess did not start within 15 seconds.\n${output}`,
    );
  } finally {
    await stopProcessGroup(child.pid);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
