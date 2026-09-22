import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

test('desktop browser is browser-host plus the official plugin, not CEF', () => {
  assert.equal(exists('crates/browser-cef'), false);
  assert.equal(exists('crates/browser-runtime'), false);
  assert.equal(exists('src-tauri/src/bin/vibex_cef_helper.rs'), false);
  assert.equal(exists('src-tauri/src/cef_pump.rs'), false);
  assert.equal(exists('src-tauri/src/commands/browser.rs'), false);
  assert.equal(exists('scripts/stage-cef-runtime.js'), false);
  assert.equal(exists('scripts/run-tauri-dev-macos.js'), false);
  assert.equal(exists('frontend/src/features/browser'), false);
  assert.equal(
    exists('frontend/src/components/panels/DockviewWebPreviewPanel.tsx'),
    false
  );

  assert.equal(exists('crates/browser-host'), true);
  assert.equal(exists('assets/plugins/browser/.vibex-plugin/plugin.json'), true);
  assert.equal(
    exists('frontend/src/features/host-browser/HostBrowserPanel.tsx'),
    true
  );

  const plugin = JSON.parse(
    readRepoFile('assets/plugins/browser/.vibex-plugin/plugin.json')
  );
  assert.equal(plugin.id, 'vibex.browser');
  assert.ok(
    plugin.integrations.some(
      (item) => item.kind === 'app.panel' && item.engine === 'host-browser'
    )
  );
  assert.ok(
    plugin.integrations.some((item) => item.kind === 'app.rail.section')
  );
  assert.ok(plugin.integrations.some((item) => item.kind === 'content.mcp'));
});

test('plugin MCP uses generic host.call injection, not a browser-specific URL', () => {
  const mcp = readRepoFile('assets/plugins/browser/runtime/mcp-server.mjs');
  const projections = readRepoFile(
    'crates/server/src/host/plugin_projections.rs'
  );
  const hostCall = readRepoFile('crates/plugins/src/host_call.rs');

  assert.match(mcp, /VIBEX_HOST_CALL_URL/);
  assert.match(mcp, /callHost\('browser'/);
  assert.doesNotMatch(mcp, /VIBEX_BROWSER_DISPATCH/);
  assert.match(projections, /attach_host_call_env/);
  assert.match(projections, /hostFamilyBinary/);
  const agent = readRepoFile('crates/browser-host/src/agent.rs');
  assert.match(agent, /__codegAgent/);
  assert.match(agent, /install_and_snapshot/);
  assert.match(agent, /act_call/);
  assert.match(hostCall, /VIBEX_HOST_CALL_TOKEN/);
  const production = hostCall.split('#[cfg(test)]')[0];
  assert.doesNotMatch(production, /vibex\.browser/);
});

test('workspace and Tauri shell no longer link CEF or desktop browser_* commands', () => {
  const workspace = readRepoFile('Cargo.toml');
  const tauriCargo = readRepoFile('src-tauri/Cargo.toml');
  const tauri = readRepoFile('src-tauri/src/lib.rs');
  const generateTypes = readRepoFile('src-tauri/src/bin/generate_types.rs');
  const hostCommands = readRepoFile('shared/hostCommands.ts');
  const desktopDev = readRepoFile('scripts/run-tauri-dev-desktop.js');
  const desktopBuild = readRepoFile('scripts/run-tauri-build.js');

  assert.match(workspace, /"crates\/browser-host"/);
  assert.doesNotMatch(workspace, /"crates\/browser-cef"/);
  assert.doesNotMatch(workspace, /"crates\/browser-runtime"/);
  assert.doesNotMatch(workspace, /^\s*cef\s*=/m);
  assert.doesNotMatch(tauriCargo, /browser-cef/);
  assert.doesNotMatch(tauri, /commands::browser::/);
  assert.doesNotMatch(tauri, /browser_create_tab|setup_unavailable_browser_runtime|pump_cef_session/);
  assert.doesNotMatch(generateTypes, /browser_create_tab|browser_apply_intent/);
  assert.doesNotMatch(hostCommands, /browser_create_tab|browser_apply_intent/);
  assert.doesNotMatch(desktopDev, /run-tauri-dev-macos/);
  assert.doesNotMatch(desktopBuild, /vibex_cef_helper|CEF_PATH/);
});

test('frontend shell opens the host-browser plugin panel instead of WEB_PREVIEW', () => {
  const layout = readRepoFile('frontend/src/stores/useLayoutStore.ts');
  const registry = readRepoFile(
    'frontend/src/components/layout/panels/PanelRegistry.tsx'
  );
  const pluginPanel = readRepoFile(
    'frontend/src/components/layout/panels/PluginDockviewPanel.tsx'
  );
  const hostPanel = readRepoFile(
    'frontend/src/features/host-browser/HostBrowserPanel.tsx'
  );
  assert.match(hostPanel, /surface.freeze/);
  const native = readRepoFile('src-tauri/src/browser_native.rs');
  assert.match(native, /tauri_runtime_wry::wry/);
  assert.match(native, /build_as_child/);
  assert.match(native, /WebViewBuilder/);
  assert.match(native, /with_focused\(false\)/);
  assert.match(native, /load_url/);
  assert.match(native, /PageLoadEvent/);
  assert.match(native, /prefer_detached_inspector/);
  assert.match(native, /takeSnapshotWithConfiguration/);
  assert.match(native, /freeze_frame/);
  assert.match(native, /with_user_agent/);
  assert.match(native, /Safari\/605\.1\.15/);
  assert.doesNotMatch(native, /\.with_url\(/);
  assert.doesNotMatch(native, /window\.add_child/);
  const picker = readRepoFile('crates/browser-host/js/picker.js');
  assert.match(picker, /59,130,246/);
  assert.doesNotMatch(picker, /139,92,246/);
  assert.match(picker, /report\(describe\(element\)\)/);
  assert.match(picker, /__vibexPickQueue/);
  const styles = readRepoFile('frontend/src/styles/legacy/index.css');
  assert.match(
    styles,
    /\.legacy-design :is\(\.astryx-text-input, \.astryx-textarea\) :is\(input, textarea\)/
  );
  assert.doesNotMatch(styles, /\.astryx-text-input \{[\s\S]*padding: 0 12px/);
  assert.match(native, /WebviewWindowBuilder/);
  assert.match(native, /target_os = "linux"/);

  assert.doesNotMatch(layout, /WEB_PREVIEW/);
  assert.doesNotMatch(registry, /WEB_PREVIEW|DockviewWebPreviewPanel/);
  assert.match(pluginPanel, /engine === 'host-browser'/);
  assert.match(pluginPanel, /HostBrowserPanel/);
  assert.match(hostPanel, /plugin_invoke_contribution/);
  assert.match(hostPanel, /browser\.dispatch/);
  assert.doesNotMatch(hostPanel, /<iframe|previewBridge|getPreviewProxyUrl/);
  assert.equal(exists('src-tauri/src/preview_proxy.rs'), false);
});

test('desktop release workflow does not download or stage CEF', () => {
  const workflow = readRepoFile('.github/workflows/desktop-release.yml');
  const beforeBundle = readRepoFile('scripts/tauri-before-bundle.js');

  assert.doesNotMatch(workflow, /CEF_PATH|Cache CEF downloads|\.cef/);
  assert.doesNotMatch(beforeBundle, /stage-cef-runtime|isCefRuntimeStaged/);
  assert.match(beforeBundle, /sidecarBinsExist/);
});
