#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const updaterTargets = [
  {
    artifactName: "VibeX-windows-x64",
    platform: "windows-x86_64",
    assetName(version) {
      return `VibeX-${version}-windows-x86_64-setup.exe`;
    },
    matches(filePath) {
      return (
        filePath.includes(`${path.sep}nsis${path.sep}`) &&
        filePath.endsWith(".exe")
      );
    },
  },
  {
    artifactName: "VibeX-windows-arm64",
    platform: "windows-aarch64",
    assetName(version) {
      return `VibeX-${version}-windows-aarch64-setup.exe`;
    },
    matches(filePath) {
      return (
        filePath.includes(`${path.sep}nsis${path.sep}`) &&
        filePath.endsWith(".exe")
      );
    },
  },
  {
    artifactName: "VibeX-linux-x64",
    platform: "linux-x86_64",
    assetName(version) {
      return `VibeX-${version}-linux-x86_64.AppImage`;
    },
    matches(filePath) {
      return filePath.endsWith(".AppImage");
    },
  },
  {
    artifactName: "VibeX-linux-arm64",
    platform: "linux-aarch64",
    assetName(version) {
      return `VibeX-${version}-linux-aarch64.AppImage`;
    },
    matches(filePath) {
      return filePath.endsWith(".AppImage");
    },
  },
  {
    artifactName: "VibeX-macos-x64",
    platform: "darwin-x86_64",
    assetName(version) {
      return `VibeX-${version}-darwin-x86_64.app.tar.gz`;
    },
    matches(filePath) {
      return filePath.endsWith(".app.tar.gz");
    },
  },
  {
    artifactName: "VibeX-macos-arm64",
    platform: "darwin-aarch64",
    assetName(version) {
      return `VibeX-${version}-darwin-aarch64.app.tar.gz`;
    },
    matches(filePath) {
      return filePath.endsWith(".app.tar.gz");
    },
  },
];

function walkFiles(root) {
  if (!fs.existsSync(root)) {
    throw new Error(`Updater artifact directory does not exist: ${root}`);
  }

  const files = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function findSignedBundle(artifactsDir, target) {
  const artifactRoot = path.join(artifactsDir, target.artifactName);
  const candidates = walkFiles(artifactRoot).filter(
    (filePath) => target.matches(filePath) && fs.existsSync(`${filePath}.sig`),
  );

  if (candidates.length !== 1) {
    throw new Error(
      `Expected one signed updater bundle for ${target.platform} in ` +
        `${artifactRoot}, found ${candidates.length}`,
    );
  }

  return candidates[0];
}

function releaseAssetUrl(repository, releaseTag, assetName) {
  return (
    `https://github.com/${repository}/releases/download/` +
    `${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`
  );
}

function readNotesOption({ notes, notesFile, releaseTag }) {
  if (typeof notesFile === "string" && notesFile.length > 0) {
    const contents = fs.readFileSync(notesFile, "utf8").trim();
    if (contents.length === 0) {
      throw new Error(`Updater notes file is empty: ${notesFile}`);
    }
    return contents;
  }
  if (typeof notes === "string" && notes.trim().length > 0) {
    return notes.trim();
  }
  return `Desktop installers for ${releaseTag}.`;
}

function generateUpdaterManifest({
  artifactsDir,
  outputDir,
  repository,
  releaseTag,
  version,
  notes,
  notesFile,
  pubDate = new Date().toISOString(),
}) {
  for (const [name, value] of Object.entries({
    artifactsDir,
    outputDir,
    repository,
    releaseTag,
    version,
  })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} is required`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const platforms = {};
  for (const target of updaterTargets) {
    const sourceBundle = findSignedBundle(artifactsDir, target);
    const sourceSignature = `${sourceBundle}.sig`;
    const assetName = target.assetName(version);
    const destinationBundle = path.join(outputDir, assetName);
    const destinationSignature = `${destinationBundle}.sig`;

    fs.copyFileSync(sourceBundle, destinationBundle);
    fs.copyFileSync(sourceSignature, destinationSignature);

    const signature = fs.readFileSync(sourceSignature, "utf8").trim();
    if (signature.length === 0) {
      throw new Error(`Updater signature is empty: ${sourceSignature}`);
    }

    platforms[target.platform] = {
      signature,
      url: releaseAssetUrl(repository, releaseTag, assetName),
    };
  }

  const manifest = {
    version,
    notes: readNotesOption({ notes, notesFile, releaseTag }),
    pub_date: pubDate,
    platforms,
  };
  const manifestPath = path.join(outputDir, "latest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function readOption(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1] || null;
  }

  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

if (require.main === module) {
  try {
    const manifestPath = generateUpdaterManifest({
      artifactsDir: readOption("--artifacts-dir"),
      outputDir: readOption("--output-dir"),
      repository: readOption("--repository"),
      releaseTag: readOption("--release-tag"),
      version: readOption("--version"),
      notes: readOption("--notes"),
      notesFile: readOption("--notes-file"),
    });
    console.log(`Generated updater manifest: ${manifestPath}`);
  } catch (error) {
    console.error(`Failed to generate updater manifest: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  generateUpdaterManifest,
};
