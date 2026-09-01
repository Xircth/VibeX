#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const workspaceRoot = path.join(__dirname, "..");

function shouldSkipFrontendBuild(env = process.env) {
  return env.VIBEX_SKIP_FRONTEND_BUILD === "1";
}

function frontendDistDir(root = workspaceRoot) {
  return path.join(root, "frontend", "dist");
}

function assertFrontendDistReady(root = workspaceRoot) {
  const index = path.join(frontendDistDir(root), "index.html");
  if (!fs.existsSync(index)) {
    throw new Error(
      "frontend/dist/index.html is missing; cannot skip the frontend build",
    );
  }
}

function buildFrontend(env = process.env) {
  const isWindows = process.platform === "win32";
  const result = isWindows
    ? spawnSync(
        env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", "pnpm", "--filter", "./frontend", "build"],
        {
          cwd: workspaceRoot,
          env,
          stdio: "inherit",
          windowsHide: true,
        },
      )
    : spawnSync("pnpm", ["--filter", "./frontend", "build"], {
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
  if (shouldSkipFrontendBuild(env)) {
    assertFrontendDistReady();
    console.log("Skipping frontend build (VIBEX_SKIP_FRONTEND_BUILD=1)");
    return;
  }
  buildFrontend(env);
}

module.exports = {
  shouldSkipFrontendBuild,
  assertFrontendDistReady,
  frontendDistDir,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
