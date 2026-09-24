import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest contributes a multi-instance browser panel and rail icon', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, '.vibex-plugin/plugin.json'), 'utf8')
  );
  assert.equal(manifest.id, 'vibex.browser');
  const panel = manifest.integrations.find((item) => item.kind === 'app.panel');
  assert.equal(panel.multiInstance, true);
  assert.equal(panel.engine, 'host-browser');
  assert.deepEqual(panel.allowedMethods, ['browser.dispatch']);
  const rail = manifest.integrations.find((item) => item.kind === 'app.rail.section');
  assert.equal(rail.opens.id, 'browser');
  assert.equal(
    manifest.integrations.some((item) => item.kind === 'app.settings.page'),
    false
  );
});

test('MCP resource advertises the same tools the stdio server implements', async () => {
  const spec = JSON.parse(
    await readFile(join(root, 'contents/mcps/browser.json'), 'utf8')
  );
  const source = await readFile(join(root, 'runtime/mcp-server.mjs'), 'utf8');
  const declared = spec.tools.map((tool) => tool.name);
  assert.deepEqual(declared, [
    'browser_list_tabs',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_open_tab',
    'browser_navigate',
    'browser_close_tab',
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
  assert.equal(spec.managedRuntime.entrypoint, 'runtime/mcp-server.mjs');
  assert.equal(spec.managedRuntime.protocolRevision, '2026-07-28');
  assert.equal(typeof spec.command, 'undefined');
});

test('MCP server calls generic host.call browser operations', async () => {
  const source = await readFile(join(root, 'runtime/mcp-server.mjs'), 'utf8');
  assert.match(source, /VIBEX_HOST_CALL_URL/);
  assert.match(source, /callHost\('browser'/);
  assert.match(source, /defaultGrant/);
  assert.match(source, /browser_open_tab/);
  assert.match(source, /await fetch\(url/);
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
    assert.ok(
      listed.result.tools.some((tool) => tool.name === 'browser_list_tabs')
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
