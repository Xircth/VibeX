const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
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
} = require("./macos-notarize-and-dmg");

test("notarytool submit returns an id instead of waiting on Apple", () => {
  const args = notarytoolSubmitArgs({
    zipPath: "/tmp/VibeX.zip",
    keyPath: "/tmp/AuthKey.p8",
    keyId: "KEYID",
    issuer: "ISSUER",
  });

  assert.equal(args[0], "notarytool");
  assert.equal(args[1], "submit");
  assert.equal(args.includes("--wait"), false);
  assert.ok(args.includes("--output-format"));
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(DEFAULT_NOTARY_TIMEOUT_SECONDS >= 7200);
});

test("parses notarytool json and retries runner network drops", () => {
  assert.equal(
    parseNotarytoolJson('{"id":"abc","status":"Accepted"}').id,
    "abc",
  );
  assert.equal(
    isTransientNotaryFailure(
      'The Internet connection appears to be offline. NSURLErrorDomain Code=-1009',
    ),
    true,
  );
  assert.equal(isTransientNotaryFailure('status: Invalid'), false);
  const info = notarytoolInfoArgs({
    id: "abc",
    keyPath: "/tmp/AuthKey.p8",
    keyId: "KEYID",
    issuer: "ISSUER",
  });
  assert.deepEqual(info.slice(0, 3), ["notarytool", "info", "abc"]);
});

test("maps Apple triples onto Tauri DMG file names", () => {
  const workspaceRoot = "/repo";
  const x64 = resolveBundleLayout({
    workspaceRoot,
    target: "x86_64-apple-darwin",
    version: "0.1.6",
  });
  const arm = resolveBundleLayout({
    workspaceRoot,
    target: "aarch64-apple-darwin",
    version: "0.1.6",
  });

  assert.equal(
    x64.appPath,
    path.join(
      workspaceRoot,
      "target/x86_64-apple-darwin/release/bundle/macos/VibeX.app",
    ),
  );
  assert.equal(
    x64.dmgPath,
    path.join(
      workspaceRoot,
      "target/x86_64-apple-darwin/release/bundle/dmg/VibeX_0.1.6_x64.dmg",
    ),
  );
  assert.equal(
    arm.dmgPath,
    path.join(
      workspaceRoot,
      "target/aarch64-apple-darwin/release/bundle/dmg/VibeX_0.1.6_aarch64.dmg",
    ),
  );
});

test("strips Apple notary variables so Tauri cannot wait forever", () => {
  const stripped = withoutAppleNotaryEnv({
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM)",
    APPLE_API_KEY: "KEYID",
    APPLE_API_ISSUER: "ISSUER",
    APPLE_API_KEY_PATH: "/tmp/key.p8",
    APPLE_ID: "dev@example.com",
    APPLE_PASSWORD: "app-specific",
    APPLE_TEAM_ID: "TEAMID",
    PATH: "/usr/bin",
  });

  assert.equal(
    stripped.APPLE_SIGNING_IDENTITY,
    "Developer ID Application: Example (TEAM)",
  );
  assert.equal(stripped.PATH, "/usr/bin");
  assert.equal(stripped.APPLE_API_KEY, undefined);
  assert.equal(stripped.APPLE_API_ISSUER, undefined);
  assert.equal(stripped.APPLE_API_KEY_PATH, undefined);
  assert.equal(stripped.APPLE_ID, undefined);
  assert.equal(stripped.APPLE_PASSWORD, undefined);
  assert.equal(stripped.APPLE_TEAM_ID, undefined);
});

test("keeps the app bundle for Tauri and takes DMG creation in-process", () => {
  assert.equal(macosWantsDmg("app,dmg"), true);
  assert.equal(macosWantsDmg("app"), false);
  assert.equal(macosTauriBundles("app,dmg"), "app");
  assert.equal(macosTauriBundles("dmg"), "app");
  assert.equal(macosTauriBundles("app"), "app");
});

test("creates a compressed DMG from a staging folder", () => {
  const args = hdiutilCreateArgs({
    volname: "VibeX",
    srcfolder: "/tmp/stage",
    dest: "/tmp/VibeX.dmg",
  });
  assert.deepEqual(args, [
    "create",
    "-volname",
    "VibeX",
    "-srcfolder",
    "/tmp/stage",
    "-ov",
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    "/tmp/VibeX.dmg",
  ]);
});

test("host Apple target follows process.arch", () => {
  const target = hostAppleTarget("arm64");
  assert.equal(target, "aarch64-apple-darwin");
  assert.equal(hostAppleTarget("x64"), "x86_64-apple-darwin");
});
