#!/usr/bin/env node

/**
 * Cross-platform standalone backend dev launcher.
 * Replaces: BACKEND_PORT=$(node scripts/setup-dev-environment.js backend) pnpm run backend:dev:watch
 */

const { spawn } = require("child_process");
const { getPorts } = require("./setup-dev-environment");

async function main() {
  const ports = await getPorts();

  const env = {
    ...process.env,
    BACKEND_PORT: String(ports.backend),
  };

  const child = spawn("pnpm", ["run", "backend:dev:watch"], {
    env,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code) => process.exit(code ?? 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
