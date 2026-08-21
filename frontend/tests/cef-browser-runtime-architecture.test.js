import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Web Preview has one CEF browser path and no iframe or proxy fallback', () => {
  const panel = readRepoFile(
    'frontend/src/components/panels/DockviewWebPreviewPanel.tsx'
  );
  const browser = readRepoFile(
    'frontend/src/features/browser/BrowserPanel.tsx'
  );

  assert.match(panel, /features\/browser\/BrowserPanel/);
  assert.match(browser, /browserApi\.createTab/);
  assert.doesNotMatch(panel, /<iframe|previewBridge|getPreviewProxyUrl/);
  assert.doesNotMatch(browser, /<iframe|previewBridge|getPreviewProxyUrl/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'src-tauri/src/preview_proxy.rs')),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, 'frontend/src/utils/installWebCompanion.ts')
    ),
    false
  );
});

test('Tauri registers the owned browser commands and every desktop bundle overlay', () => {
  const tauri = readRepoFile('src-tauri/src/lib.rs');
  const workspace = readRepoFile('Cargo.toml');

  assert.match(workspace, /"crates\/browser-cef"/);
  assert.match(tauri, /commands::browser::browser_create_tab/);
  assert.match(tauri, /commands::browser::browser_apply_intent/);
  assert.match(tauri, /commands::browser::browser_close_tab/);
  assert.doesNotMatch(tauri, /\bmod preview_proxy\b|preview_proxy::/);

  for (const platform of ['macos', 'linux', 'windows']) {
    assert.equal(
      fs.existsSync(
        path.join(repoRoot, `src-tauri/tauri.${platform}.conf.json`)
      ),
      true
    );
  }
});

test('closing an embedded CEF tab owns child teardown without closing the Tauri parent', () => {
  const cefHost = readRepoFile('crates/browser-cef/src/cef_host/mod.rs');
  const nativeHost = readRepoFile('crates/browser-cef/src/cef_host/native.rs');
  const lifeSpanHandler = cefHost.slice(
    cefHost.indexOf('cef::wrap_life_span_handler!'),
    cefHost.indexOf('cef::wrap_display_handler!')
  );

  assert.match(
    cefHost,
    /BrowserEngineCommand::Close[\s\S]*native::hide_browser_view\(browser\)[\s\S]*close_browser\(1\)/
  );
  assert.match(
    lifeSpanHandler,
    /fn do_close[\s\S]*schedule_browser_view_destruction\(browser\)[\s\S]*\n\s*1\n/
  );
  assert.match(
    cefHost,
    /fn schedule_browser_view_destruction[\s\S]*post_delayed_task\([\s\S]*ThreadId::UI[\s\S]*BROWSER_VIEW_TEARDOWN_DELAY_MS/
  );
  assert.match(
    cefHost,
    /struct VibeXDestroyBrowserViewTask[\s\S]*fn execute[\s\S]*native::destroy_browser_view\(&self\.browser\)/
  );
  assert.doesNotMatch(
    lifeSpanHandler.slice(
      lifeSpanHandler.indexOf('fn do_close'),
      lifeSpanHandler.indexOf('fn on_before_close')
    ),
    /native::destroy_browser_view/,
    'native teardown must leave the active CEF close callback stack'
  );
  assert.equal(
    nativeHost.match(/pub fn hide_browser_view/g)?.length,
    3,
    'macOS, Windows, and Linux must hide only the CEF child view'
  );
  assert.equal(
    nativeHost.match(/pub fn destroy_browser_view/g)?.length,
    3,
    'macOS, Windows, and Linux must destroy only the CEF child view'
  );
});

test('CEF paints the light content background before the first page frame', () => {
  const cefHost = readRepoFile('crates/browser-cef/src/cef_host/mod.rs');

  assert.match(
    cefHost,
    /const BROWSER_CONTENT_BACKGROUND_COLOR: u32 = 0xFFFAFBFC;/
  );
  assert.match(
    cefHost,
    /fn browser_settings\(\) -> BrowserSettings[\s\S]*background_color: BROWSER_CONTENT_BACKGROUND_COLOR/
  );
  assert.match(
    cefHost,
    /browser_host_create_browser\([\s\S]*Some\(&browser_settings\(\)\)/
  );
});

test('macOS desktop dev runs CEF from the required app bundle', () => {
  const runnerPath = path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js');
  assert.equal(fs.existsSync(runnerPath), true);

  const { parseCargoRunArgs, resolveMacosDevPaths } = require(runnerPath);
  assert.deepEqual(
    parseCargoRunArgs([
      'run',
      '--no-default-features',
      '--color',
      'always',
      '--',
      '--inspect',
    ]),
    {
      appArgs: ['--inspect'],
      buildArgs: [
        'build',
        '--no-default-features',
        '--color',
        'always',
        '--bin',
        'vibex',
        '--bin',
        'vibex_cef_helper',
      ],
      profile: 'debug',
    }
  );

  const paths = resolveMacosDevPaths(
    '/workspace',
    '/workspace/target/debug/vibex'
  );
  assert.equal(
    paths.appExecutable,
    '/workspace/target/cef-runtime/macos/app/vibex.app/Contents/MacOS/vibex'
  );
  assert.equal(
    paths.frameworkResources,
    '/workspace/target/cef-runtime/macos/app/vibex.app/Contents/Frameworks/Chromium Embedded Framework.framework/Resources'
  );

  const desktopDev = readRepoFile('scripts/run-tauri-dev-desktop.js');
  assert.match(desktopDev, /run-tauri-dev-macos\.js/);
  assert.match(desktopDev, /--runner/);
});

test('macOS desktop dev re-signs the bundle after replacing executables', () => {
  const runner = readRepoFile('scripts/run-tauri-dev-macos.js');
  const terminate = runner.indexOf('terminateTrackedDevApp(paths);');
  const refresh = runner.indexOf('refreshBundleExecutables(paths, profileDirectory);');
  const sign = runner.indexOf('signDevBundle(paths.appRoot);');
  const launch = runner.indexOf(
    'const child = spawn(paths.appExecutable, parsed.appArgs'
  );

  assert.ok(terminate >= 0);
  assert.ok(refresh > terminate);
  assert.ok(sign > refresh);
  assert.ok(launch > sign);
  assert.match(runner, /collectStaleDevAppPids/);
  assert.match(runner, /removeCodesignTempFiles\(appRoot\)/);
  assert.match(runner, /\['--force', '--deep', '--sign', '-', appRoot\]/);
  assert.match(runner, /\['--verify', '--deep', '--strict', appRoot\]/);
  assert.match(runner, /'-p', 'vibex-mcp'/);
});

test('macOS CEF dev runner removes leftover codesign temp files before signing', () => {
  const runnerPath = path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js');
  const { removeCodesignTempFiles } = require(runnerPath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-cef-sign-'));
  const macos = path.join(fixture, 'Contents', 'MacOS');

  try {
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, 'vibex'), 'app');
    fs.writeFileSync(path.join(macos, 'vibex.cstemp'), 'stale codesign copy');
    fs.writeFileSync(path.join(macos, 'vibex.next-42277'), 'interrupted copy');
    removeCodesignTempFiles(fixture);
    assert.equal(fs.existsSync(path.join(macos, 'vibex.cstemp')), false);
    assert.equal(fs.existsSync(path.join(macos, 'vibex.next-42277')), false);
    assert.equal(fs.readFileSync(path.join(macos, 'vibex'), 'utf8'), 'app');
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

test('macOS CEF dev bundle cache ignores packaging-only overlay links', () => {
  const runnerPath = path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js');
  const { isStagedBundleReady } = require(runnerPath);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-cef-dev-'));
  const frameworkResources = path.join(fixture, 'framework-resources');
  const helperExecutable = path.join(fixture, 'helper');
  const manifest = path.join(fixture, 'cef-runtime-manifest.json');

  try {
    fs.mkdirSync(frameworkResources);
    fs.writeFileSync(path.join(frameworkResources, 'icudtl.dat'), 'icu');
    fs.writeFileSync(helperExecutable, 'helper');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        requiredFiles: ['packaging-only-overlay-link'],
      })
    );

    assert.equal(
      isStagedBundleReady({
        frameworkResources,
        helperExecutables: [{ destination: helperExecutable }],
        manifest,
      }),
      true
    );
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

test(
  'macOS CEF dev runner replaces live executables atomically',
  { skip: process.platform === 'win32' },
  () => {
    const runnerPath = path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js');
    const { replaceExecutable } = require(runnerPath);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-cef-bin-'));
    const source = path.join(fixture, 'source');
    const destination = path.join(fixture, 'destination');

    try {
      fs.writeFileSync(source, 'new executable');
      fs.writeFileSync(destination, 'running executable');
      const originalInode = fs.statSync(destination).ino;

      replaceExecutable(source, destination);

      assert.equal(fs.readFileSync(destination, 'utf8'), 'new executable');
      assert.notEqual(fs.statSync(destination).ino, originalInode);
    } finally {
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  }
);

test('macOS CEF dev runner identifies only its staged app command', () => {
  const runnerPath = path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js');
  const { isTrackedDevAppCommand } = require(runnerPath);
  const stagedExecutable =
    '/workspace/target/cef-runtime/macos/app/vibex.app/Contents/MacOS/vibex';

  assert.equal(
    isTrackedDevAppCommand(stagedExecutable, stagedExecutable),
    true
  );
  assert.equal(
    isTrackedDevAppCommand(`${stagedExecutable} --inspect`, stagedExecutable),
    true
  );
  assert.equal(
    isTrackedDevAppCommand(
      '/Applications/VibeX.app/Contents/MacOS/vibex',
      stagedExecutable
    ),
    false
  );
});

test('macOS CEF dev runner collects orphaned staged app pids without a pidfile', () => {
  const runnerPath = path.join(repoRoot, 'scripts', 'run-tauri-dev-macos.js');
  const { collectStaleDevAppPids } = require(runnerPath);
  const stagedExecutable =
    '/workspace/target/cef-runtime/macos/app/vibex.app/Contents/MacOS/vibex';

  assert.deepEqual(
    collectStaleDevAppPids(
      [
        '  407 /usr/libexec/rapportd',
        `94310 ${stagedExecutable}`,
        `  512 ${stagedExecutable} --inspect`,
        '  611 /Applications/VibeX.app/Contents/MacOS/vibex',
        `  702 ${stagedExecutable}-helper`,
      ].join('\n'),
      stagedExecutable
    ),
    [94310, 512]
  );
});
