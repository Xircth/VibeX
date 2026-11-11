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
  assert.deepEqual(manifest.entrypoints.app, {
    entry: 'app/main.js',
    protocol: '2.0',
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
  assert.match(skillDoc, /browser_prefer/);
  assert.match(skillDoc, /overMs/);
  assert.match(skillDoc, /everyMs/);
  assert.match(skillDoc, /reducedMotion/);
  assert.match(skillDoc, /browser_hover/);
  assert.match(skillDoc, /browser_press_key/);
  assert.match(skillDoc, /browser_select_option/);
  assert.match(skillDoc, /vibex-browser-browser-tools/);
});

test('MCP resource advertises all 14 tools that the stdio server implements', async () => {
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
    'browser_prefer',
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
    assert.equal(listed.result.tools.length, 14);
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
    assert.ok(
      listed.result.tools.some((tool) => tool.name === 'browser_prefer')
    );
  } finally {
    child.kill();
  }
});

test('MCP server answers Claude Code server/discover with 2026-07-28', async () => {
  const child = spawn(process.execPath, [join(root, 'runtime/mcp-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 'server-discover-probe-1',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'claude-code',
            version: '2.1.303',
          },
        },
      },
    })}\n`
  );
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('server/discover timed out')),
      2000
    );
    const check = () => {
      const line = Buffer.concat(stdout)
        .toString('utf8')
        .split('\n')
        .find((item) => item.trim());
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    };
    child.stdout.on('data', check);
    check();
  });
  try {
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.resultType, 'complete');
    assert.deepEqual(reply.result.supportedVersions, ['2026-07-28']);
    assert.equal(
      reply.result._meta['io.modelcontextprotocol/serverInfo'].name,
      'vibex-browser'
    );
  } finally {
    child.kill();
  }
});

test('MCP server echoes handshake revision 2025-06-18', async () => {
  const child = spawn(process.execPath, [join(root, 'runtime/mcp-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })}\n`
  );
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('2025-06-18 initialize timed out')),
      2000
    );
    const check = () => {
      const line = Buffer.concat(stdout)
        .toString('utf8')
        .split('\n')
        .find((item) => item.trim());
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    };
    child.stdout.on('data', check);
    check();
  });
  try {
    assert.equal(reply.result.protocolVersion, '2025-06-18');
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

test('browser-settings ships v2 app/main.js entrypoint and settings view', async () => {
  const manifest = JSON.parse(
    await readFile(join(root, '.vibex-plugin/plugin.json'), 'utf8')
  );
  const settingsPage = manifest.integrations.find(
    (item) => item.kind === 'app.settings.page'
  );
  assert.ok(settingsPage, 'expected app.settings.page integration');
  assert.deepEqual(manifest.entrypoints.app, {
    entry: 'app/main.js',
    protocol: '2.0',
  });

  const appMain = await readFile(join(root, 'app/main.js'), 'utf8');
  assert.match(appMain, /apiVersion:\s*['"]2\.0['"]/);
  assert.match(appMain, /id:\s*['"]vibex\.browser['"]/);
  assert.match(appMain, /\.\.\/src\/views\/view/);

  const viewSource = await readFile(join(root, 'src/views/view.tsx'), 'utf8');
  assert.match(viewSource, /browser\.dispatch/);
  assert.match(viewSource, /启用或修改Agent的Browser Use（浏览器控制）功能/);
});

test('browser_prefer and browser_screenshot support contact-sheet burst, reducedMotion, and eval.run fallback', async () => {
  const { createServer } = await import('node:http');
  const calls = [];
  let preferUnimplemented = false;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      calls.push(payload);
      res.setHeader('content-type', 'application/json');

      if (payload.operation === 'prefer') {
        if (preferUnimplemented) {
          res.statusCode = 501;
          res.end(
            JSON.stringify({
              code: 'capability_unimplemented',
              message: 'prefer is not implemented',
            })
          );
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            tabId: payload.input?.tabId || 'tab-1',
            url: 'https://example.com/app',
            reducedMotion: Boolean(payload.input?.reducedMotion),
            colorScheme: payload.input?.colorScheme || 'no-preference',
            settled: payload.input?.settle !== false,
          })
        );
        return;
      }

      if (payload.operation === 'tab.list') {
        res.end(
          JSON.stringify({
            tabs: [
              {
                tabId: 'tab-1',
                url: 'https://example.com/app',
                title: 'App',
                grant: { level: 'control' },
              },
            ],
          })
        );
        return;
      }

      if (payload.operation === 'eval.run') {
        res.end(
          JSON.stringify({
            tabId: payload.input?.tabId || 'tab-1',
            value: JSON.stringify({
              ok: true,
              url: 'https://example.com/app',
              reducedMotion: true,
              colorScheme: 'dark',
              settled: true,
            }),
          })
        );
        return;
      }

      if (payload.operation === 'screenshot') {
        res.end(
          JSON.stringify({
            tabId: payload.input?.tabId || 'tab-1',
            url: 'https://example.com/app',
            mime: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            width: 1280,
            height: 720,
            framesCount: 6,
            overMs: payload.input?.overMs ?? 500,
            everyMs: payload.input?.everyMs ?? 100,
            timestampsMs: [0, 100, 200, 300, 400, 500],
            columns: 3,
            rows: 2,
          })
        );
        return;
      }

      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const hostUrl = `http://127.0.0.1:${address.port}/host-call`;

  const child = spawn(process.execPath, [join(root, 'runtime/mcp-server.mjs')], {
    env: {
      ...process.env,
      VIBEX_HOST_CALL_URL: hostUrl,
      VIBEX_HOST_CALL_TOKEN: 'test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));

  const callRpc = (id, method, params) => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`RPC ${id} timed out`)),
        3000
      );
      const check = () => {
        const lines = Buffer.concat(stdout)
          .toString('utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              clearTimeout(timer);
              child.stdout.off('data', check);
              resolve(parsed);
              return;
            }
          } catch {
            // ignore partial line
          }
        }
      };
      child.stdout.on('data', check);
      check();
    });
  };

  try {
    // 1. Direct host prefer call
    const preferReply = await callRpc(10, 'tools/call', {
      name: 'browser_prefer',
      arguments: {
        tabId: 'tab-1',
        reducedMotion: true,
        colorScheme: 'dark',
      },
    });
    assert.equal(preferReply.error, undefined);
    assert.equal(preferReply.result.isError, undefined);
    assert.match(
      preferReply.result.content[0].text,
      /Browser preferences applied/
    );
    assert.match(preferReply.result.content[0].text, /Reduced motion: `true`/);
    assert.match(preferReply.result.content[0].text, /Color scheme: `dark`/);
    assert.equal(calls.at(-1).operation, 'prefer');
    assert.equal(calls.at(-1).input.settle, true);

    // 2. Fallback to eval.run when host returns capability_unimplemented
    preferUnimplemented = true;
    const fallbackReply = await callRpc(11, 'tools/call', {
      name: 'browser_prefer',
      arguments: {
        reducedMotion: true,
        colorScheme: 'dark',
        settle: false,
      },
    });
    assert.equal(fallbackReply.error, undefined);
    assert.equal(fallbackReply.result.isError, undefined);
    const evalCall = calls.find((item) => item.operation === 'eval.run');
    assert.ok(evalCall, 'expected eval.run fallback call for browser_prefer');
    assert.match(evalCall.input.code, /__vibex_prefer_reduced_motion/);
    assert.match(evalCall.input.code, /prefers-reduced-motion/);

    // 3. Contact-sheet burst screenshot with overMs, everyMs, reducedMotion, colorScheme
    const shotReply = await callRpc(12, 'tools/call', {
      name: 'browser_screenshot',
      arguments: {
        tabId: 'tab-1',
        overMs: 500,
        everyMs: 100,
        reducedMotion: true,
        colorScheme: 'dark',
      },
    });
    assert.equal(shotReply.error, undefined);
    assert.equal(shotReply.result.isError, undefined);
    const shotCall = calls.find((item) => item.operation === 'screenshot');
    assert.ok(shotCall, 'expected host screenshot call');
    assert.equal(shotCall.input.overMs, 500);
    assert.equal(shotCall.input.everyMs, 100);
    assert.equal(shotCall.input.reducedMotion, true);
    assert.equal(shotCall.input.colorScheme, 'dark');
    assert.match(
      shotReply.result.content[0].text,
      /frames=6, over=500ms, every=100ms, timestamps=\[0ms, 100ms, 200ms, 300ms, 400ms, 500ms\]/
    );
    assert.equal(shotReply.result.content[1].type, 'image');
  } finally {
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
});


