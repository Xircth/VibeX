const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const os = require('node:os');

const {
  applyDesktopDevIdentity,
  clearIncrementalCacheIfDisabled,
  createCargoLeanDevEnv,
  DESKTOP_DEV_IDENTITY,
  relocateStaleWebView2UserData,
  webview2DevUserDataDir,
  windowsStaleDesktopCleanupScript,
} = require('./run-tauri-dev-desktop');

test('desktop dev compiles SQLx queries from the prepared cache', () => {
  const env = createCargoLeanDevEnv({ frontend: 3000, backend: 3001 }, {});

  assert.equal(env.SQLX_OFFLINE, 'true');
  assert.equal(
    env.SQLX_OFFLINE_DIR,
    path.join(process.cwd(), 'crates', 'db', '.sqlx')
  );
});

test('desktop dev keeps an explicit signing identity from the process environment', () => {
  const env = createCargoLeanDevEnv(
    { frontend: 3000, backend: 3001 },
    {
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAMID)',
    }
  );

  assert.equal(
    env.APPLE_SIGNING_IDENTITY,
    'Developer ID Application: Test (TEAMID)'
  );
});

test('desktop dev injects debug sidecar paths and watches official MCP crates', () => {
  const env = createCargoLeanDevEnv(
    { frontend: 3000, backend: 3001 },
    { CARGO_TARGET_DIR: path.join('/custom-target') }
  );
  const source = fs.readFileSync(
    path.join(__dirname, 'run-tauri-dev-desktop.js'),
    'utf8'
  );
  const mcpName =
    process.platform === 'win32' ? 'vibex-mcp.exe' : 'vibex-mcp';
  const workflowName =
    process.platform === 'win32'
      ? 'vibex-workflow-mcp.exe'
      : 'vibex-workflow-mcp';

  assert.equal(
    env.VIBEX_MCP_BIN,
    path.join('/custom-target', 'debug', mcpName)
  );
  assert.equal(
    env.VIBEX_WORKFLOW_MCP_BIN,
    path.join('/custom-target', 'debug', workflowName)
  );
  assert.match(source, /watchHostSidecars/);
  assert.match(source, /applySidecarDevEnv/);
  assert.match(source, /rebuildHostSidecars/);
});

test('desktop dev uses a distinct app identity from the installed product', () => {
  const productConfigPath = path.join(
    __dirname,
    '..',
    'src-tauri',
    'tauri.conf.json'
  );
  const product = JSON.parse(fs.readFileSync(productConfigPath, 'utf8'));
  const generated = applyDesktopDevIdentity(product);

  assert.equal(product.identifier, 'com.vibex.app');
  assert.equal(product.productName, 'VibeX');
  assert.deepEqual(product.plugins['deep-link'].desktop.schemes, ['vibex']);
  assert.equal(generated.identifier, DESKTOP_DEV_IDENTITY.identifier);
  assert.equal(generated.productName, DESKTOP_DEV_IDENTITY.productName);
  assert.equal(
    generated.app.windows.find((window) => window.label === 'main'),
    undefined
  );
  assert.deepEqual(generated.plugins['deep-link'].desktop.schemes, [
    DESKTOP_DEV_IDENTITY.deepLinkScheme,
  ]);
  assert.notEqual(generated.identifier, product.identifier);
  assert.equal(product.identifier, 'com.vibex.app');
});

test('desktop dev cleanup reaps WebView2 processes that hold the dev user-data folder', () => {
  const script = windowsStaleDesktopCleanupScript();
  assert.match(script, /msedgewebview2\.exe/);
  assert.match(script, /com\.vibex\.app\.dev/);
  assert.match(script, /taskkill\.exe/);
  assert.match(script, /Start-Sleep/);
});

test('desktop dev WebView2 user data lives under LOCALAPPDATA and the dev identity', () => {
  assert.equal(
    webview2DevUserDataDir({ LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }),
    path.join('C:\\Users\\test\\AppData\\Local', DESKTOP_DEV_IDENTITY.identifier)
  );
  assert.equal(webview2DevUserDataDir({}), null);
});

test('desktop dev relocates a busy WebView2 profile so the next Environment can start', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-wv2-'));
  const dir = path.join(parent, DESKTOP_DEV_IDENTITY.identifier);
  fs.mkdirSync(path.join(dir, 'EBWebView', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'EBWebView', 'Default', 'LOCK'), 'busy');

  const stale = relocateStaleWebView2UserData(dir, 1700000000000);
  assert.ok(stale);
  assert.equal(
    path.basename(stale),
    `${DESKTOP_DEV_IDENTITY.identifier}.stale-1700000000000`
  );
  assert.equal(fs.existsSync(dir), false);
  assert.equal(
    fs.existsSync(path.join(stale, 'EBWebView', 'Default', 'LOCK')),
    true
  );
  assert.equal(relocateStaleWebView2UserData(dir, 1700000000001), null);

  fs.rmSync(parent, { recursive: true, force: true });
});

test('desktop dev tolerates Windows ENOTEMPTY/EBUSY when clearing target/debug/incremental', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibex-inc-'));
  const incremental = path.join(root, 'target', 'debug', 'incremental');
  fs.mkdirSync(incremental, { recursive: true });

  let capturedOptions = null;
  assert.doesNotThrow(() => {
    clearIncrementalCacheIfDisabled(
      { CARGO_INCREMENTAL: '0' },
      root,
      (_target, options) => {
        capturedOptions = options;
        const err = new Error('ENOTEMPTY: directory not empty');
        err.code = 'ENOTEMPTY';
        throw err;
      }
    );
  });
  assert.equal(capturedOptions?.recursive, true);
  assert.equal(capturedOptions?.force, true);
  assert.ok(capturedOptions?.maxRetries >= 3);

  fs.rmSync(root, { recursive: true, force: true });
});
