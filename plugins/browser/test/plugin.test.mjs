import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = existsSync(join(process.cwd(), '.vibex-plugin/plugin.json'))
  ? process.cwd()
  : join(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest contributes browser panel, dedicated browser settings page, and rail icon', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, '.vibex-plugin/plugin.json'), 'utf8')
  );
  assert.equal(manifest.id, 'vibex.browser');
  const panel = manifest.integrations.find((item) => item.kind === 'app.panel');
  assert.equal(panel.multiInstance, true);
  assert.equal(panel.engine, 'host-browser');
  assert.deepEqual(panel.allowedMethods, ['browser.dispatch']);

  const settingsPage = manifest.integrations.find(
    (item) => item.kind === 'app.settings.page'
  );
  assert.ok(settingsPage, 'expected app.settings.page integration');
  assert.equal(settingsPage.id, 'browser-settings');
  assert.equal(settingsPage.title, '浏览器');
  assert.equal(settingsPage.handler, 'surface.createSession');
  assert.deepEqual(settingsPage.allowedMethods, ['browser.dispatch']);
  assert.deepEqual(settingsPage.remote, {
    name: 'vibex_browser',
    entry: 'dist/remoteEntry.js',
    module: './view',
  });

  const rail = manifest.integrations.find(
    (item) => item.kind === 'app.rail.section'
  );
  assert.equal(rail.opens.id, 'browser');

  const skill = manifest.integrations.find(
    (item) => item.kind === 'content.skill'
  );
  assert.equal(skill.resource, 'contents/skills/vibex-browser');
  const skillDoc = await readFile(
    join(root, 'contents/skills/vibex-browser/SKILL.md'),
    'utf8'
  );
  assert.match(skillDoc, /^---\r?\nname: vibex-browser\r?\n/m);
  assert.match(skillDoc, /browser_list_tabs/);
  assert.match(skillDoc, /browser_open_tab/);
  assert.match(skillDoc, /browser_snapshot/);
  assert.match(skillDoc, /browser_console_messages/);
  assert.match(skillDoc, /browser_screenshot/);
  assert.match(skillDoc, /browser_hover/);
  assert.match(skillDoc, /browser_press_key/);
  assert.match(skillDoc, /browser_select_option/);
  assert.match(skillDoc, /vibex-browser-browser-tools/);
});

test('MCP resource advertises all 13 tools that the stdio server implements', async () => {
  const spec = JSON.parse(
    await readFile(join(root, 'contents/mcps/browser.json'), 'utf8')
  );
  const source = await readFile(join(root, 'runtime/mcp-server.mjs'), 'utf8');
  const declared = spec.tools.map((tool) => tool.name);
  assert.deepEqual(declared, [
    'browser_list_tabs',
    'browser_open_tab',
    'browser_navigate',
    'browser_close_tab',
    'browser_snapshot',
    'browser_console_messages',
    'browser_screenshot',
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_press_key',
    'browser_select_option',
    'browser_eval',
  ]);
  for (const name of declared) {
    assert.match(source, new RegExp(`name: '${name}'`));
  }
});

test('MCP resource uses a packaged entrypoint and advertises tools separately', async () => {
  const spec = JSON.parse(
    await readFile(join(root, 'contents/mcps/browser.json'), 'utf8')
  );
  assert.equal(spec.managedRuntime.source, 'runtime/mcp-server.mjs');
  assert.equal(spec.managedRuntime.entrypoint, 'dist/mcp/mcp-server.mjs');
  assert.equal(spec.managedRuntime.protocolRevision, '2026-07-28');
  assert.equal(typeof spec.command, 'undefined');
  const packaged = await readFile(
    join(root, spec.managedRuntime.entrypoint),
    'utf8'
  );
  for (const name of spec.tools.map((tool) => tool.name)) {
    assert.match(packaged, new RegExp(`name:\\s*['"]${name}['"]`));
  }
});

test('MCP server calls generic host.call browser operations', async () => {
  const source = await readFile(join(root, 'runtime/mcp-server.mjs'), 'utf8');
  assert.match(source, /VIBEX_HOST_CALL_URL/);
  assert.match(source, /callHost\('browser'/);
  assert.match(source, /defaultGrant/);
  assert.match(source, /browser_open_tab/);
  assert.match(source, /await fetch\(url/);
  assert.match(source, /host_call_unreachable/);
  assert.doesNotMatch(source, /VIBEX_BROWSER_DISPATCH/);
  assert.doesNotMatch(
    source,
    /Content-Type: application\/json\\r\\nContent-Length/
  );
});

test('MCP server answers NDJSON initialize without closing', async () => {
  const child = spawn(process.execPath, [join(root, 'runtime/mcp-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'vibex-test', version: '0' },
      },
    })}\n`
  );

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `MCP initialize timed out stdout=${Buffer.concat(stdout).toString()} stderr=${Buffer.concat(stderr).toString()}`
        )
      );
    }, 2000);
    const check = () => {
      const text = Buffer.concat(stdout).toString('utf8');
      const line = text.split('\n').find((item) => item.trim());
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on('data', check);
    check();
  });

  try {
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, 1);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.protocolVersion, '2025-03-26');
    assert.equal(reply.result.serverInfo.name, 'vibex-browser');

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`
    );
    const listed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('tools/list timed out after initialize'));
      }, 2000);
      const check = () => {
        const lines = Buffer.concat(stdout)
          .toString('utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        const tools = lines.find((item) => item.id === 2);
        if (!tools) return;
        clearTimeout(timer);
        resolve(tools);
      };
      child.stdout.on('data', check);
      check();
    });
    assert.equal(listed.error, undefined);
    assert.ok(Array.isArray(listed.result.tools));
    assert.equal(listed.result.tools.length, 13);
    assert.ok(
      listed.result.tools.some((tool) => tool.name === 'browser_list_tabs')
    );
    assert.ok(
      listed.result.tools.some(
        (tool) => tool.name === 'browser_console_messages'
      )
    );
    assert.ok(
      listed.result.tools.some((tool) => tool.name === 'browser_screenshot')
    );
  } finally {
    child.kill();
  }
});

test('MCP server answers Content-Length initialize without closing', async () => {
  const child = spawn(process.execPath, [join(root, 'runtime/mcp-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'vibex-test', version: '0' },
    },
  });
  child.stdin.write(
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
  );

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `MCP initialize timed out stdout=${Buffer.concat(stdout).toString()} stderr=${Buffer.concat(stderr).toString()}`
        )
      );
    }, 2000);
    const check = () => {
      const text = Buffer.concat(stdout).toString('utf8');
      const match = text.match(/Content-Length:\s*(\d+)\r\n\r\n([\s\S]*)/i);
      if (!match) return;
      const size = Number(match[1]);
      const payload = match[2];
      if (Buffer.byteLength(payload, 'utf8') < size) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(payload.slice(0, size)));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on('data', check);
    check();
  });

  try {
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, 1);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.protocolVersion, '2026-07-28');
    assert.equal(reply.result.serverInfo.name, 'vibex-browser');
  } finally {
    child.kill();
  }
});

test('browser-settings ships both Module Federation remoteEntry.js and bundled app/index.html', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, '.vibex-plugin/plugin.json'), 'utf8')
  );
  const settingsPage = manifest.integrations.find(
    (item) => item.kind === 'app.settings.page'
  );
  assert.deepEqual(settingsPage.remote, {
    name: 'vibex_browser',
    entry: 'dist/remoteEntry.js',
    module: './view',
  });

  const remoteEntry = await readFile(join(root, 'dist/remoteEntry.js'), 'utf8');
  assert.ok(remoteEntry.length > 500, 'dist/remoteEntry.js must be bundled');
  assert.match(remoteEntry, /vibex_browser/);

  const assetsDir = join(root, 'dist/assets');
  const assetFiles = readdirSync(assetsDir);
  const exposeName = remoteEntry.match(/virtualExposes-[A-Za-z0-9_-]+\.js/)?.[0];
  assert.ok(exposeName, 'remoteEntry must point at virtualExposes');
  const exposeBundle = await readFile(join(assetsDir, exposeName), 'utf8');
  const viewFile = exposeBundle.match(/view-[A-Za-z0-9_-]+\.js/)?.[0];
  assert.ok(viewFile, 'expected the settings view chunk referenced by virtualExposes');
  const viewBundle = await readFile(join(assetsDir, viewFile), 'utf8');
  assert.match(viewBundle, /export\{[A-Za-z0-9_$]+ as default\}/);
  assert.doesNotMatch(viewBundle, /as mount\b/);
  assert.match(viewBundle, /astryx-select/);
  assert.match(viewBundle, /astryx-button/);
  assert.match(viewBundle, /data-variant/);
  assert.match(viewBundle, /12px/);
  assert.match(viewBundle, /无痕/);
  assert.match(viewBundle, /启用或修改Agent的Browser Use（浏览器控制）功能/);
  assert.doesNotMatch(viewBundle, /配置内置工作区浏览器的基础策略/);
  assert.doesNotMatch(
    viewBundle,
    /管理链接默认打开方式、WebView 开发者工具/
  );
  assert.match(viewBundle, /settings-page/);
  assert.match(viewBundle, /settings-sections/);

  const loadShareReactFile = assetFiles.find(
    (file) =>
      file.includes('__loadShare__react__loadShare__.js-') &&
      !file.includes('commonjs-proxy')
  );
  assert.ok(loadShareReactFile, 'expected loadShare react chunk');
  const loadShareReactBundle = await readFile(
    join(assetsDir, loadShareReactFile),
    'utf8'
  );
  assert.match(loadShareReactBundle, /canonical:"default:react"/);
  assert.match(loadShareReactBundle, /\.useState/);
  assert.match(loadShareReactBundle, /\.useEffect/);
  assert.doesNotMatch(loadShareReactBundle, /react\.production\.js/);

  const appHtml = await readFile(join(root, 'dist/app/index.html'), 'utf8');
  assert.match(appHtml, /BrowserSettingsRemoteView/);
  assert.match(appHtml, /vibex:host-browser-prefs:v1/);
  assert.match(appHtml, /browser\.dispatch/);
  assert.match(appHtml, /settings-sections/);
});

