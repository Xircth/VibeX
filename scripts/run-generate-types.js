#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

const { withCargoBinOnPath } = require("./cargo-path");

const workspaceRoot = path.join(__dirname, "..");
const sqlxOfflineDir = path.join(workspaceRoot, "crates", "db", ".sqlx");
const cargo = "cargo";
const args = ["run", "--bin", "generate_types", "--", ...process.argv.slice(2)];

const result = spawnSync(cargo, args, {
  cwd: workspaceRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...withCargoBinOnPath(process.env),
    SQLX_OFFLINE: "true",
    SQLX_OFFLINE_DIR: sqlxOfflineDir,
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
