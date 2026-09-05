/**
 * The one place VibeX Host family release asset names are defined.
 *
 * `.github/workflows/host-family-release.yml` produces these names, and every
 * client that downloads them — `npx-cli`, `install.sh`, `install.ps1` — has to
 * ask for the exact same string. When those drifted apart the published
 * archives were simply unreachable, so `release-assets.test.js` holds the
 * producer, this module, and both install scripts to one answer.
 */

/**
 * Platform segment of an asset name: `<os>-<arch>`, matching the Rust target
 * triple's OS and architecture. These are the values the release matrix builds.
 */
const PLATFORMS = [
  'linux-x86_64',
  'linux-aarch64',
  'darwin-aarch64',
  'windows-x86_64',
  'windows-aarch64',
];

const NODE_PLATFORM_TO_OS = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
};

const NODE_ARCH_TO_ARCH = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

/** `uname -s` values, lowercased. */
const UNAME_SYSTEM_TO_OS = {
  linux: 'linux',
  darwin: 'darwin',
};

/** `uname -m` values, including the aliases each OS reports. */
const UNAME_MACHINE_TO_ARCH = {
  x86_64: 'x86_64',
  amd64: 'x86_64',
  arm64: 'aarch64',
  aarch64: 'aarch64',
};

function platformId(os, arch) {
  if (!os || !arch) return null;
  const id = `${os}-${arch}`;
  return PLATFORMS.includes(id) ? id : null;
}

/** Resolve the platform segment for a running Node process. */
function platformFromNode(nodePlatform, nodeArch) {
  return platformId(
    NODE_PLATFORM_TO_OS[nodePlatform],
    NODE_ARCH_TO_ARCH[nodeArch]
  );
}

/** Resolve the platform segment from `uname -s` / `uname -m`. */
function platformFromUname(system, machine) {
  return platformId(
    UNAME_SYSTEM_TO_OS[String(system).toLowerCase()],
    UNAME_MACHINE_TO_ARCH[String(machine).toLowerCase()]
  );
}

/**
 * Release tags are `v${version}`; the version inside the asset name carries no
 * leading `v`.
 */
function versionFromTag(tag) {
  return String(tag).replace(/^v/, '');
}

function archiveName(version, platform) {
  return `VibeX-${versionFromTag(version)}-${platform}-server.tar.gz`;
}

function checksumName(version, platform) {
  return `${archiveName(version, platform)}.sha256`;
}

function releaseBaseUrl(repo, tag) {
  return `https://github.com/${repo}/releases/download/${tag}`;
}

module.exports = {
  PLATFORMS,
  archiveName,
  checksumName,
  platformFromNode,
  platformFromUname,
  releaseBaseUrl,
  versionFromTag,
};

/**
 * Shell entry point, so the release workflow derives asset names from this
 * module instead of re-spelling them in YAML.
 *
 *   node release-assets.js archive <version> <platform>
 *   node release-assets.js checksum <version> <platform>
 *   node release-assets.js platforms
 */
if (require.main === module) {
  const [command, version, platform] = process.argv.slice(2);
  const emit = {
    archive: () => archiveName(version, platform),
    checksum: () => checksumName(version, platform),
    platforms: () => PLATFORMS.join('\n'),
  }[command];
  if (!emit) {
    console.error('usage: release-assets.js <archive|checksum|platforms> [version] [platform]');
    process.exit(2);
  }
  if (command !== 'platforms' && !PLATFORMS.includes(platform)) {
    console.error(`unknown platform: ${platform}`);
    process.exit(2);
  }
  console.log(emit());
}
