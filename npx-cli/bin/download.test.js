const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CLI_VERSION,
  DEFAULT_GITHUB_REPO,
  ensureHostFamily,
  familyAssetName,
  familyAssetUrl,
  parseSha256Sums,
  sha256File,
  verifyFileDigest,
  verifySha256Sums,
} = require("./download");

test("builds GitHub release URLs for the official Host family tarball", () => {
  assert.equal(
    familyAssetName("darwin-aarch64"),
    `Dimo-${CLI_VERSION}-darwin-aarch64-server.tar.gz`,
  );
  assert.equal(
    familyAssetUrl("linux-x86_64"),
    `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/v${CLI_VERSION}/Dimo-${CLI_VERSION}-linux-x86_64-server.tar.gz`,
  );
  assert.equal(
    familyAssetUrl("windows-x86_64", ".sha256"),
    `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/v${CLI_VERSION}/Dimo-${CLI_VERSION}-windows-x86_64-server.tar.gz.sha256`,
  );
});

test("parses sha256sum lines and verifies extracted family files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-family-sum-"));
  const server = path.join(root, "dimo-server");
  const nested = path.join(root, "web", "index.html");
  fs.writeFileSync(server, "server-bin");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, "<html></html>");
  const serverDigest = crypto.createHash("sha256").update("server-bin").digest("hex");
  const webDigest = crypto.createHash("sha256").update("<html></html>").digest("hex");
  const sums = `${serverDigest}  dimo-server\n${webDigest}  web/index.html\n`;

  const parsed = parseSha256Sums(sums);
  assert.equal(parsed.get("dimo-server"), serverDigest);
  assert.equal(parsed.get("web/index.html"), webDigest);
  assert.equal(sha256File(server), serverDigest);
  verifyFileDigest(server, serverDigest);
  verifySha256Sums(root, sums);
  assert.throws(
    () => verifyFileDigest(server, "0".repeat(64)),
    /Checksum mismatch/,
  );
});

test("rejects a family whose SHA256SUMS does not match the bytes on disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-family-bad-"));
  fs.writeFileSync(path.join(root, "dimo-server"), "tampered");
  const expected = crypto.createHash("sha256").update("server-bin").digest("hex");
  assert.throws(
    () => verifySha256Sums(root, `${expected}  dimo-server\n`),
    /Checksum mismatch/,
  );
});

test("ensureHostFamily uses a local directory after verifying SHA256SUMS", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-family-local-"));
  const server = path.join(root, "dimo-server");
  fs.writeFileSync(server, "server-bin");
  const digest = crypto.createHash("sha256").update("server-bin").digest("hex");
  fs.writeFileSync(path.join(root, "SHA256SUMS"), `${digest}  dimo-server\n`);
  const previous = process.env.DIMO_HOST_FAMILY_DIR;
  process.env.DIMO_HOST_FAMILY_DIR = root;
  try {
    const family = await ensureHostFamily("darwin-aarch64");
    assert.equal(family.source, "local");
    assert.equal(family.root, root);
  } finally {
    if (previous === undefined) {
      delete process.env.DIMO_HOST_FAMILY_DIR;
    } else {
      process.env.DIMO_HOST_FAMILY_DIR = previous;
    }
  }
});
