#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workspaceRoot = path.join(__dirname, "..");
const PRODUCT_NAME = "VibeX";
const DEFAULT_NOTARY_TIMEOUT_SECONDS = 3600;
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

function notarytoolSubmitArgs({
  zipPath,
  keyPath,
  keyId,
  issuer,
  timeoutSeconds = DEFAULT_NOTARY_TIMEOUT_SECONDS,
}) {
  return [
    "notarytool",
    "submit",
    zipPath,
    "--key",
    keyPath,
    "--key-id",
    keyId,
    "--issuer",
    issuer,
    "--wait",
    "--timeout",
    String(timeoutSeconds),
  ];
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

function notarizeAndStaple({ appPath, zipPath, env, timeoutSeconds }) {
  const keyPath = env.APPLE_API_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Apple API key file is missing: ${keyPath}`);
  }

  console.log(`Creating notarization zip at ${zipPath}`);
  fs.rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);

  console.log(
    `Submitting ${path.basename(appPath)} to notarytool (timeout ${timeoutSeconds}s)`,
  );
  try {
    run(
      "xcrun",
      notarytoolSubmitArgs({
        zipPath,
        keyPath,
        keyId: env.APPLE_API_KEY,
        issuer: env.APPLE_API_ISSUER,
        timeoutSeconds,
      }),
    );
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
  macosTauriBundles,
  macosWantsDmg,
  notarytoolSubmitArgs,
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
