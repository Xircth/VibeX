#!/usr/bin/env node

/**
 * Cross-platform backend dev:watch launcher.
 * Replaces: DISABLE_WORKTREE_CLEANUP=1 RUST_LOG=debug cargo watch -w crates -x 'run --bin server'
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const env = {
  ...process.env,
  DISABLE_WORKTREE_CLEANUP: "1",
  RUST_LOG: process.env.RUST_LOG || "debug",
  CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL || "0",
};

if (env.CARGO_INCREMENTAL === "0") {
  const incrementalPath = path.join(process.cwd(), "target", "debug", "incremental");
  if (fs.existsSync(incrementalPath)) {
    fs.rmSync(incrementalPath, { recursive: true, force: true });
  }
}

// Don't use shell: true — pass args as an array so they aren't re-split.
const child = spawn("cargo", ["watch", "-w", "crates", "-x", "run --bin server"], {
  env,
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error("Failed to start cargo watch:", err.message);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 1));
