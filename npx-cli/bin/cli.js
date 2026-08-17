#!/usr/bin/env node

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  CLI_VERSION,
  ensureHostFamily,
  familyTag,
  hostBinary,
} = require("./download");

function getEffectiveArch() {
  const platform = process.platform;
  const nodeArch = process.arch;

  if (platform === "darwin") {
    if (nodeArch === "arm64") return "arm64";
    try {
      const translated = execSync("sysctl -in sysctl.proc_translated", {
        encoding: "utf8",
      }).trim();
      if (translated === "1") return "arm64";
    } catch {
      // sysctl key not present → assume true Intel
    }
    return "x64";
  }

  if (/arm/i.test(nodeArch)) return "arm64";

  if (platform === "win32") {
    const pa = process.env.PROCESSOR_ARCHITECTURE || "";
    const paw = process.env.PROCESSOR_ARCHITEW6432 || "";
    if (/arm/i.test(pa) || /arm/i.test(paw)) return "arm64";
  }

  return "x64";
}

function getPlatformDir() {
  const platform = process.platform;
  const arch = getEffectiveArch();
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";

  console.error(`Unsupported platform: ${platform}-${arch}`);
  console.error("Host family tarballs are published for:");
  console.error("  linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64");
  process.exit(1);
}

function showProgress(downloaded, total) {
  const percent = total ? Math.round((downloaded / total) * 100) : 0;
  const mb = (downloaded / (1024 * 1024)).toFixed(1);
  const totalMb = total ? (total / (1024 * 1024)).toFixed(1) : "?";
  process.stderr.write(`\r   Downloading: ${mb}MB / ${totalMb}MB (${percent}%)`);
}

function runBinary(binPath, args, env) {
  const proc = spawn(binPath, args, { stdio: "inherit", env });
  proc.on("exit", (code) => process.exit(code || 0));
  proc.on("error", (error) => {
    console.error(`${path.basename(binPath)} failed: ${error.message}`);
    process.exit(1);
  });
  process.on("SIGINT", () => proc.kill("SIGINT"));
  process.on("SIGTERM", () => proc.kill("SIGTERM"));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "conversation" || args[0] === "workflow") {
    await require("./control").run(args);
    return;
  }
  if (args[0] === "review") {
    console.error("review is not part of the Host family package.");
    process.exit(1);
  }

  const platformDir = getPlatformDir();
  console.error(`Fetching VibeX Host family ${familyTag()} for ${platformDir}...`);
  let family;
  try {
    family = await ensureHostFamily(platformDir, showProgress);
    if (family.source === "download") {
      console.error("");
    }
  } catch (error) {
    console.error(`\nHost family download failed: ${error.message}`);
    process.exit(1);
  }

  const isMcpMode = args.includes("--mcp");
  const serverArgs = args.filter((arg) => arg !== "--mcp");
  const binName = isMcpMode ? "vibex-mcp" : "vibex-server";
  const binPath = hostBinary(family.root, binName);
  if (!fs.existsSync(binPath)) {
    console.error(`Host family is missing ${binName} at ${binPath}`);
    process.exit(1);
  }

  const env = { ...process.env };
  if (!isMcpMode) {
    const staticRoot = path.join(family.root, "web");
    if (fs.existsSync(staticRoot)) {
      env.VIBEX_STATIC_ROOT = staticRoot;
    }
  }

  if (!isMcpMode) {
    console.error(`Starting VibeX Host ${CLI_VERSION} (${family.source})...`);
  }
  runBinary(binPath, serverArgs, env);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  if (process.env.VIBEX_DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
