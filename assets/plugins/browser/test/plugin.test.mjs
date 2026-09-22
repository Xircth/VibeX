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
});

test('MCP server calls generic host.call browser operations', async () => {
  const source = await readFile(join(root, 'runtime/mcp-server.mjs'), 'utf8');
  assert.match(source, /VIBEX_HOST_CALL_URL/);
  assert.match(source, /callHost\('browser'/);
  assert.doesNotMatch(source, /VIBEX_BROWSER_DISPATCH/);
  assert.doesNotMatch(source, /Content-Length/);
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
  }).finally(() => {
    child.kill();
  });

  assert.equal(reply.jsonrpc, '2.0');
  assert.equal(reply.id, 1);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.protocolVersion, '2025-03-26');
  assert.equal(reply.result.serverInfo.name, 'vibex-browser');
});
