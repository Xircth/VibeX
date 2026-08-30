import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('desktop release version has one value across frontend, Tauri, and Cargo', () => {
  const frontendVersion = readJson('frontend/package.json').version;
  const tauriVersionSource = readJson('src-tauri/tauri.conf.json').version;
  const tauriVersion = tauriVersionSource.endsWith('.json')
    ? readJson(path.join('src-tauri', tauriVersionSource)).version
    : tauriVersionSource;
  const cargoVersion = read('src-tauri/Cargo.toml').match(
    /^version\s*=\s*"([^"]+)"/m
  )?.[1];
  const cefStager = read('crates/browser-cef/src/bin/stage_cef_runtime.rs');

  assert.equal(tauriVersion, frontendVersion);
  assert.equal(tauriVersionSource, '../package.json');
  assert.equal(cargoVersion, frontendVersion);
  assert.match(cefStager, /package\.json/);
  assert.doesNotMatch(cefStager, /Version::new\(0,\s*1,\s*0\)/);
});

test('installed desktop identity stays distinct from the development instance', () => {
  const config = readJson('src-tauri/tauri.conf.json');
  const cefStager = read('crates/browser-cef/src/bin/stage_cef_runtime.rs');
  const macosRunner = read('scripts/run-tauri-dev-macos.js');
  const packagingStager = read('scripts/stage-cef-runtime.js');

  assert.equal(config.identifier, 'com.vibex.app');
  assert.equal(config.productName, 'VibeX');
  assert.deepEqual(config.plugins['deep-link'].desktop.schemes, ['vibex']);
  assert.match(cefStager, /com\.vibex\.app\.dev/);
  assert.match(cefStager, /--dev-bundle/);
  assert.match(macosRunner, /--dev-bundle/);
  assert.doesNotMatch(packagingStager, /--dev-bundle/);
});

test('Windows installer is self-contained for WebView2', () => {
  const config = readJson('src-tauri/tauri.windows.conf.json');

  assert.equal(
    config.bundle?.windows?.webviewInstallMode?.type,
    'offlineInstaller'
  );
});

test('macOS bundle declares its minimum supported system version', () => {
  const config = readJson('src-tauri/tauri.macos.conf.json');

  assert.match(config.bundle?.macOS?.minimumSystemVersion ?? '', /^\d+\.\d+$/);
  assert.equal(
    config.bundle?.macOS?.entitlements,
    'entitlements.macos.plist'
  );
  assert.equal(fs.existsSync(path.join(repoRoot, 'src-tauri', 'entitlements.macos.plist')), true);
});

test('Linux Debian package declares the XWayland runtime required by CEF', () => {
  const config = readJson('src-tauri/tauri.linux.conf.json');

  assert.ok(config.bundle?.linux?.deb?.depends?.includes('xwayland'));
});

test('desktop release builds every supported OS and CPU architecture', () => {
  const workflow = read('.github/workflows/desktop-release.yml');
  const updater = read('scripts/generate-updater-manifest.js');
  const targets = [
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'aarch64-apple-darwin',
  ];

  for (const target of targets) {
    assert.match(workflow, new RegExp(`target: ${target}`));
  }
  for (const platform of [
    'windows-x86_64',
    'windows-aarch64',
    'linux-x86_64',
    'linux-aarch64',
    'darwin-x86_64',
    'darwin-aarch64',
  ]) {
    assert.match(updater, new RegExp(`platform: ['"]${platform}['"]`));
  }
});

test('local Apple signing is loaded from gitignored env without committing secrets', () => {
  const gitignore = read('.gitignore');
  const example = read('.env.example');
  const desktopDev = read('scripts/run-tauri-dev-desktop.js');
  const desktopBuild = read('scripts/run-tauri-build.js');

  assert.match(gitignore, /^\.env\.local$/m);
  assert.match(example, /APPLE_SIGNING_IDENTITY=/);
  assert.match(example, /APPLE_API_KEY=/);
  assert.match(example, /APPLE_API_ISSUER=/);
  assert.match(example, /APPLE_API_KEY_PATH=/);
  assert.match(desktopDev, /applyLocalEnvFile/);
  assert.match(desktopBuild, /applyLocalEnvFile/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts', 'load-local-env.js')), true);
});

test('desktop release signs and verifies macOS and Windows artifacts', () => {
  const workflow = read('.github/workflows/desktop-release.yml');
  const macosRelease = read('scripts/macos-notarize-and-dmg.js');

  for (const requiredText of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'WINDOWS_CERTIFICATE',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'EVSIGN_LICENSE_KEY',
    'Import-PfxCertificate',
    'scripts/sign-windows-evsign.ps1',
    'scripts/macos-notarize-and-dmg.js',
    'timeout-minutes: 140',
    'codesign --verify --deep --strict',
    'Get-AuthenticodeSignature',
  ]) {
    assert.match(workflow, new RegExp(requiredText));
  }

  assert.match(macosRelease, /notarytool/);
  assert.match(macosRelease, /notarytool",\s*"info"/);
  assert.match(macosRelease, /isTransientNotaryFailure/);
  assert.match(macosRelease, /hdiutil/);
});

test('Windows EVSign signing refreshes updater signatures after Authenticode', () => {
  const script = read('scripts/sign-windows-evsign.ps1');

  assert.match(
    script,
    /releases\/download\/evsign-cli-1\.0\.1\/evsign-client-cli-win_v1\.0\.1\.exe/
  );
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.match(script, /-cdn/);
  assert.match(script, /tauri signer sign/);
  assert.match(script, /TAURI_SIGNING_PRIVATE_KEY/);
});

test('desktop release runs platform-native startup smoke tests', () => {
  const workflow = read('.github/workflows/desktop-release.yml');

  for (const script of [
    'scripts/smoke-windows-desktop.ps1',
    'scripts/smoke-macos-desktop.sh',
    'scripts/smoke-linux-desktop.sh',
  ]) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, script)),
      `${script} must exist`
    );
    assert.ok(
      workflow.includes(script),
      `${script} must run in desktop release CI`
    );
  }
});
