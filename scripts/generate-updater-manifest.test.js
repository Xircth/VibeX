const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { generateUpdaterManifest } = require("./generate-updater-manifest");

function writeArtifact(root, relativePath, contents) {
  const artifactPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, contents);
}

test("generates a six-platform updater manifest without asset collisions", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibex-updater-manifest-"),
  );
  const artifactsDir = path.join(temporaryRoot, "artifacts");
  const outputDir = path.join(temporaryRoot, "release");

  try {
    const fixtures = [
      [
        "VibeX-windows-x64/bundle/nsis/VibeX_0.1.1_x64-setup.exe",
        "windows bundle",
        "windows signature",
      ],
      [
        "VibeX-windows-arm64/bundle/nsis/VibeX_0.1.1_arm64-setup.exe",
        "windows ARM64 bundle",
        "windows ARM64 signature",
      ],
      [
        "VibeX-linux-x64/bundle/appimage/VibeX_0.1.1_amd64.AppImage",
        "linux bundle",
        "linux signature",
      ],
      [
        "VibeX-linux-arm64/bundle/appimage/VibeX_0.1.1_arm64.AppImage",
        "linux ARM64 bundle",
        "linux ARM64 signature",
      ],
      [
        "VibeX-macos-x64/bundle/macos/VibeX.app.tar.gz",
        "macOS x64 bundle",
        "macOS x64 signature",
      ],
      [
        "VibeX-macos-arm64/bundle/macos/VibeX.app.tar.gz",
        "macOS arm64 bundle",
        "macOS arm64 signature",
      ],
      [
        "VibeX-macos-x64/bundle/dmg/VibeX_0.1.1_x64.dmg",
        "macOS x64 disk image",
      ],
      [
        "VibeX-macos-arm64/bundle/dmg/VibeX_0.1.1_aarch64.dmg",
        "macOS arm64 disk image",
      ],
    ];

    for (const [relativePath, bundle, signature] of fixtures) {
      writeArtifact(artifactsDir, relativePath, bundle);
      if (signature) {
        writeArtifact(artifactsDir, `${relativePath}.sig`, `${signature}\n`);
      }
    }

    const notesPath = path.join(temporaryRoot, "notes.md");
    fs.writeFileSync(notesPath, "## English\n\nReal notes\n\n## 中文\n\n说明\n");

    const manifestPath = generateUpdaterManifest({
      artifactsDir,
      outputDir,
      repository: "Xircth/VibeX",
      releaseTag: "v0.1.1",
      version: "0.1.1",
      notesFile: notesPath,
      pubDate: "2026-07-28T00:00:00.000Z",
    });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    assert.deepEqual(manifest, {
      version: "0.1.1",
      notes: "## English\n\nReal notes\n\n## 中文\n\n说明",
      pub_date: "2026-07-28T00:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          signature: "windows signature",
          url: "https://github.com/Xircth/VibeX/releases/download/v0.1.1/VibeX-0.1.1-windows-x86_64-setup.exe",
        },
        "windows-aarch64": {
          signature: "windows ARM64 signature",
          url: "https://github.com/Xircth/VibeX/releases/download/v0.1.1/VibeX-0.1.1-windows-aarch64-setup.exe",
        },
        "linux-x86_64": {
          signature: "linux signature",
          url: "https://github.com/Xircth/VibeX/releases/download/v0.1.1/VibeX-0.1.1-linux-x86_64.AppImage",
        },
        "linux-aarch64": {
          signature: "linux ARM64 signature",
          url: "https://github.com/Xircth/VibeX/releases/download/v0.1.1/VibeX-0.1.1-linux-aarch64.AppImage",
        },
        "darwin-x86_64": {
          signature: "macOS x64 signature",
          url: "https://github.com/Xircth/VibeX/releases/download/v0.1.1/VibeX-0.1.1-darwin-x86_64.app.tar.gz",
        },
        "darwin-aarch64": {
          signature: "macOS arm64 signature",
          url: "https://github.com/Xircth/VibeX/releases/download/v0.1.1/VibeX-0.1.1-darwin-aarch64.app.tar.gz",
        },
      },
    });

    for (const assetName of [
      "VibeX-0.1.1-windows-x86_64-setup.exe",
      "VibeX-0.1.1-windows-aarch64-setup.exe",
      "VibeX-0.1.1-linux-x86_64.AppImage",
      "VibeX-0.1.1-linux-aarch64.AppImage",
      "VibeX-0.1.1-darwin-x86_64.app.tar.gz",
      "VibeX-0.1.1-darwin-aarch64.app.tar.gz",
    ]) {
      assert.equal(fs.existsSync(path.join(outputDir, assetName)), true);
      assert.equal(
        fs.existsSync(path.join(outputDir, `${assetName}.sig`)),
        true,
      );
    }

    for (const assetName of [
      "VibeX-0.1.1-darwin-x86_64.dmg",
      "VibeX-0.1.1-darwin-aarch64.dmg",
    ]) {
      assert.equal(fs.existsSync(path.join(outputDir, assetName)), true);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
