const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PLATFORMS,
  archiveName,
  checksumName,
  platformFromNode,
  platformFromUname,
  releaseBaseUrl,
  versionFromTag,
} = require('../npx-cli/bin/release-assets');

const ROOT = path.join(__dirname, '..');

test('asset names match the archives CI already publishes', () => {
  assert.equal(archiveName('0.1.9', 'linux-x86_64'), 'VibeX-0.1.9-linux-x86_64-server.tar.gz');
  assert.equal(archiveName('v0.1.9', 'darwin-aarch64'), 'VibeX-0.1.9-darwin-aarch64-server.tar.gz');
  assert.equal(
    checksumName('0.1.9', 'windows-x86_64'),
    'VibeX-0.1.9-windows-x86_64-server.tar.gz.sha256'
  );
  assert.equal(versionFromTag('v0.1.9'), '0.1.9');
  assert.equal(
    releaseBaseUrl('Xircth/VibeX', 'v0.1.9'),
    'https://github.com/Xircth/VibeX/releases/download/v0.1.9'
  );
});

test('every published platform maps from Node and uname', () => {
  assert.deepEqual(PLATFORMS, [
    'linux-x86_64',
    'linux-aarch64',
    'darwin-aarch64',
    'windows-x86_64',
    'windows-aarch64',
  ]);
  assert.equal(platformFromNode('linux', 'x64'), 'linux-x86_64');
  assert.equal(platformFromNode('linux', 'arm64'), 'linux-aarch64');
  assert.equal(platformFromNode('darwin', 'x64'), null);
  assert.equal(platformFromNode('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformFromNode('win32', 'x64'), 'windows-x86_64');
  assert.equal(platformFromNode('win32', 'arm64'), 'windows-aarch64');
  assert.equal(platformFromNode('freebsd', 'x64'), null);

  assert.equal(platformFromUname('Linux', 'x86_64'), 'linux-x86_64');
  assert.equal(platformFromUname('Linux', 'amd64'), 'linux-x86_64');
  assert.equal(platformFromUname('Darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformFromUname('Darwin', 'aarch64'), 'darwin-aarch64');
  assert.equal(platformFromUname('Darwin', 'x86_64'), null);
  assert.equal(platformFromUname('SunOS', 'x86_64'), null);
});

test('npx, install.sh, and install.ps1 all ask for the CI archive name', () => {
  const { familyAssetName, familyAssetUrl, familyTag, CLI_VERSION } = require(
    '../npx-cli/bin/download'
  );
  const tag = familyTag();
  const version = versionFromTag(tag);
  for (const platform of PLATFORMS) {
    const archive = archiveName(version, platform);
    assert.equal(familyAssetName(platform), archive);
    assert.equal(
      familyAssetUrl(platform),
      `https://github.com/Xircth/VibeX/releases/download/${tag}/${archive}`
    );
    assert.equal(familyAssetUrl(platform, '.sha256'), `${familyAssetUrl(platform)}.sha256`);
  }
  assert.equal(CLI_VERSION, require('../package.json').version);

  const installSh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(installSh, /archive="VibeX-\$\{version\}-\$\{platform\}-server\.tar\.gz"/);
  assert.match(installSh, /SUPPORTED_PLATFORMS="linux-x86_64 linux-aarch64 darwin-aarch64 windows-x86_64 windows-aarch64"/);

  const installPs1 = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  assert.match(installPs1, /\$archive = "VibeX-\$version-\$platform-server\.tar\.gz"/);
  for (const platform of PLATFORMS) {
    assert.match(installPs1, new RegExp(`"${platform}"`));
  }
});

test('the release workflow derives the archive name from the naming module', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/host-family-release.yml'),
    'utf8'
  );
  assert.match(
    workflow,
    /ARCHIVE="\$\(node npx-cli\/bin\/release-assets\.js archive "\$\{VERSION\}" "\$\{\{ matrix\.release_name \}\}"\)"/
  );
  assert.doesNotMatch(workflow, /ARCHIVE="VibeX-\$\{VERSION\}-/);
  for (const platform of PLATFORMS) {
    assert.match(workflow, new RegExp(`release_name: ${platform}`));
  }
});
