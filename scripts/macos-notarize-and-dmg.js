#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workspaceRoot = path.join(__dirname, "..");
const PRODUCT_NAME = "VibeX";
const DEFAULT_NOTARY_TIMEOUT_SECONDS = 7200;
const NOTARY_POLL_INTERVAL_SECONDS = 20;
const NOTARY_SUBMIT_ATTEMPTS = 3;
const DMG_ATTEMPTS = 3;
const APPLE_NOTARY_ENV_KEYS = [
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
];

function hostAppleTarget(arch = process.arch) {
  if (arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (arch === "x64") {
    return "x86_64-apple-darwin";
  }
  throw new Error(`Unsupported macOS architecture: ${arch}`);
}

function tauriArchSuffix(target) {
  if (target === "x86_64-apple-darwin") {
    return "x64";
  }
  if (target === "aarch64-apple-darwin") {
    return "aarch64";
  }
  throw new Error(`Unsupported macOS target: ${target}`);
}

function macosWantsDmg(bundles) {
  return String(bundles || "")
    .split(",")
    .map((part) => part.trim())
    .includes("dmg");
}

function macosTauriBundles(requested) {
  const parts = String(requested || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.includes("dmg") || parts.includes("app")) {
    return ["app", ...parts.filter((part) => part !== "dmg" && part !== "app")].join(
      ",",
    );
  }
  return requested;
}

function withoutAppleNotaryEnv(env) {
  const next = { ...env };
  for (const key of APPLE_NOTARY_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

function resolveBundleLayout({
  workspaceRoot: root,
  target,
  version,
  productName = PRODUCT_NAME,
}) {
  const suffix = tauriArchSuffix(target);
  const bundleRoot = path.join(root, "target", target, "release", "bundle");
  const macosDir = path.join(bundleRoot, "macos");
  const dmgDir = path.join(bundleRoot, "dmg");
  return {
    bundleRoot,
    macosDir,
    dmgDir,
    appPath: path.join(macosDir, `${productName}.app`),
    zipPath: path.join(macosDir, `${productName}.zip`),
    dmgName: `${productName}_${version}_${suffix}.dmg`,
    dmgPath: path.join(dmgDir, `${productName}_${version}_${suffix}.dmg`),
  };
}

function appleAuthArgs({ keyPath, keyId, issuer }) {
  return ["--key", keyPath, "--key-id", keyId, "--issuer", issuer];
}

function notarytoolSubmitArgs({ zipPath, keyPath, keyId, issuer }) {
  return [
    "notarytool",
    "submit",
    zipPath,
    ...appleAuthArgs({ keyPath, keyId, issuer }),
    "--output-format",
    "json",
  ];
}

function notarytoolInfoArgs({ id, keyPath, keyId, issuer }) {
  return [
    "notarytool",
    "info",
    id,
    ...appleAuthArgs({ keyPath, keyId, issuer }),
    "--output-format",
    "json",
  ];
}

function parseNotarytoolJson(output) {
  const text = String(output || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`notarytool did not return JSON: ${text}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function isTransientNotaryFailure(output) {
  const text = String(output || "");
  return (
    /Internet connection appears to be offline/i.test(text) ||
    /NSURLErrorDomain/i.test(text) ||
    /Code=-100[0-9]/i.test(text) ||
    /unsatisfied \(No network route\)/i.test(text) ||
    /The request timed out/i.test(text) ||
    /Connection reset/i.test(text) ||
    /Network is unreachable/i.test(text)
  );
}

function hdiutilCreateArgs({ volname, srcfolder, dest }) {
  return [
    "create",
    "-volname",
    volname,
    "-srcfolder",
    srcfolder,
    "-ov",
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    dest,
  ];
}

function readOption(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1] || null;
  }
  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

function hasFlag(name, args = process.argv.slice(2)) {
  return args.includes(name);
}

function packageVersion(root = workspaceRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    .version;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "null"}`,
    );
  }
  return result;
}

function hasNotaryCredentials(env) {
  return Boolean(env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH);
}

function runCaptured(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function commandOutput(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function sleepSeconds(seconds) {
  spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
}

function submitForNotarization({ zipPath, env }) {
  const args = notarytoolSubmitArgs({
    zipPath,
    keyPath: env.APPLE_API_KEY_PATH,
    keyId: env.APPLE_API_KEY,
    issuer: env.APPLE_API_ISSUER,
  });
  let lastError = new Error("notarytool submit did not run");
  for (let attempt = 1; attempt <= NOTARY_SUBMIT_ATTEMPTS; attempt += 1) {
    console.log(`Uploading notarization zip (attempt ${attempt}/${NOTARY_SUBMIT_ATTEMPTS})`);
    const result = runCaptured("xcrun", args);
    const output = commandOutput(result);
    if (output) {
      console.log(output);
    }
    if (result.status === 0) {
      const parsed = parseNotarytoolJson(result.stdout);
      if (!parsed.id) {
        throw new Error(`notarytool submit succeeded without an id: ${output}`);
      }
      return parsed.id;
    }
    lastError = new Error(
      `notarytool submit failed with status ${result.status ?? "null"}: ${output}`,
    );
    if (!isTransientNotaryFailure(output) || attempt === NOTARY_SUBMIT_ATTEMPTS) {
      throw lastError;
    }
    sleepSeconds(NOTARY_POLL_INTERVAL_SECONDS);
  }
  throw lastError;
}

function waitForNotarization({ id, env, timeoutSeconds }) {
  const auth = {
    keyPath: env.APPLE_API_KEY_PATH,
    keyId: env.APPLE_API_KEY,
    issuer: env.APPLE_API_ISSUER,
  };
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = runCaptured("xcrun", notarytoolInfoArgs({ id, ...auth }));
    const output = commandOutput(result);
    if (result.status !== 0) {
      if (isTransientNotaryFailure(output)) {
        console.log(`Transient notary poll failure for ${id}; retrying...`);
        sleepSeconds(NOTARY_POLL_INTERVAL_SECONDS);
        continue;
      }
      throw new Error(
        `notarytool info failed with status ${result.status ?? "null"}: ${output}`,
      );
    }
    const parsed = parseNotarytoolJson(result.stdout);
    const status = parsed.status || "Unknown";
    console.log(`Notary status for ${id}: ${status}`);
    if (status === "Accepted") {
      return parsed;
    }
    if (status === "Invalid" || status === "Rejected") {
      throw new Error(`Notarization ${status} for ${id}`);
    }
    sleepSeconds(NOTARY_POLL_INTERVAL_SECONDS);
  }
  throw new Error(
    `Notarization still in progress after ${timeoutSeconds}s (id ${id})`,
  );
}

function notarizeAndStaple({ appPath, zipPath, env, timeoutSeconds }) {
  const keyPath = env.APPLE_API_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Apple API key file is missing: ${keyPath}`);
  }

  console.log(`Creating notarization zip at ${zipPath}`);
  fs.rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);

  try {
    const id = submitForNotarization({ zipPath, env });
    console.log(
      `Submitted ${path.basename(appPath)} as ${id}; polling up to ${timeoutSeconds}s`,
    );
    waitForNotarization({ id, env, timeoutSeconds });
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  console.log("Stapling notarization ticket");
  run("xcrun", ["stapler", "staple", "-v", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
}

function detachVolume(productName) {
  spawnSync("hdiutil", ["detach", `/Volumes/${productName}`, "-force"], {
    encoding: "utf8",
    stdio: "inherit",
  });
}

function createDmg({ appPath, dmgPath, productName, identity }) {
  fs.mkdirSync(path.dirname(dmgPath), { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-dmg-"));
  try {
    const stagedApp = path.join(staging, path.basename(appPath));
    run("ditto", [appPath, stagedApp]);
    fs.symlinkSync("/Applications", path.join(staging, "Applications"));
    detachVolume(productName);

    let lastError = new Error("hdiutil create did not run");
    for (let attempt = 1; attempt <= DMG_ATTEMPTS; attempt += 1) {
      fs.rmSync(dmgPath, { force: true });
      console.log(`Creating DMG (attempt ${attempt}/${DMG_ATTEMPTS}): ${dmgPath}`);
      const result = spawnSync(
        "hdiutil",
        hdiutilCreateArgs({
          volname: productName,
          srcfolder: staging,
          dest: dmgPath,
        }),
        { encoding: "utf8", stdio: "inherit" },
      );
      if (result.status === 0 && fs.existsSync(dmgPath)) {
        lastError = null;
        break;
      }
      lastError = new Error(
        `hdiutil create failed with status ${result.status ?? "null"}`,
      );
      detachVolume(productName);
    }
    if (lastError) {
      throw lastError;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  if (identity) {
    console.log(`Signing DMG with ${identity}`);
    run("codesign", ["--force", "--sign", identity, "--timestamp", dmgPath]);
    run("codesign", ["--verify", "--verbose=2", dmgPath]);
  }
}

function findExistingApp(workspaceRootPath, target, productName) {
  const candidates = [];
  if (target) {
    candidates.push(
      path.join(
        workspaceRootPath,
        "target",
        target,
        "release",
        "bundle",
        "macos",
        `${productName}.app`,
      ),
    );
  } else {
    candidates.push(
      path.join(
        workspaceRootPath,
        "target",
        "release",
        "bundle",
        "macos",
        `${productName}.app`,
      ),
    );
    candidates.push(
      path.join(
        workspaceRootPath,
        "target",
        hostAppleTarget(),
        "release",
        "bundle",
        "macos",
        `${productName}.app`,
      ),
    );
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `Missing ${productName}.app. Looked in:\n${candidates.join("\n")}`,
    );
  }
  return found;
}

function main(args = process.argv.slice(2), env = process.env) {
  if (process.platform !== "darwin") {
    throw new Error("macOS notarization and DMG creation require darwin");
  }

  const target = readOption("--target", args) || hostAppleTarget();
  const timeoutSeconds = Number(
    readOption("--timeout", args) || env.VIBEX_NOTARY_TIMEOUT_SECONDS || DEFAULT_NOTARY_TIMEOUT_SECONDS,
  );
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Notary timeout must be a positive number of seconds");
  }

  const skipNotarize = hasFlag("--skip-notarize", args);
  const version = packageVersion();
  const layout = resolveBundleLayout({
    workspaceRoot,
    target,
    version,
  });
  const appPath = findExistingApp(workspaceRoot, target, PRODUCT_NAME);
  layout.appPath = appPath;
  layout.zipPath = path.join(path.dirname(appPath), `${PRODUCT_NAME}.zip`);
  layout.dmgDir = path.join(path.dirname(path.dirname(appPath)), "dmg");
  layout.dmgPath = path.join(layout.dmgDir, layout.dmgName);

  if (!skipNotarize && hasNotaryCredentials(env)) {
    notarizeAndStaple({
      appPath,
      zipPath: layout.zipPath,
      env,
      timeoutSeconds,
    });
  } else if (!skipNotarize) {
    console.log("Skipping notarization; Apple API credentials are not configured.");
  }

  createDmg({
    appPath,
    dmgPath: layout.dmgPath,
    productName: PRODUCT_NAME,
    identity: env.APPLE_SIGNING_IDENTITY || "",
  });

  console.log(`macOS disk image ready: ${layout.dmgPath}`);
  return layout;
}

module.exports = {
  DEFAULT_NOTARY_TIMEOUT_SECONDS,
  hdiutilCreateArgs,
  hostAppleTarget,
  isTransientNotaryFailure,
  macosTauriBundles,
  macosWantsDmg,
  notarytoolInfoArgs,
  notarytoolSubmitArgs,
  parseNotarytoolJson,
  resolveBundleLayout,
  withoutAppleNotaryEnv,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
