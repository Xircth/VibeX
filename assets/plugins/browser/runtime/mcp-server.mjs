#!/usr/bin/env node
/**
 * MCP stdio server for built-in browser tools.
 * Host injects VIBEX_HOST_CALL_* when projecting this content.mcp.
 * Framing accepts MCP NDJSON and LSP Content-Length. Tools are advertised
 * only while config.json toolsEnabled is true; eval is a separate switch.
 * Grant checks stay in Host BrowserService.
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORTED_PROTOCOLS = [
  '2024-11-05',
  '2025-03-26',
  '2025-11-25',
  '2026-07-28',
];

const allTools = [
  {
    name: 'browser_list_tabs',
    operation: 'tab.list',
    description:
      "List pages in VibeX's built-in browser. Reading a page requires the user to share that tab.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    operation: 'snapshot',
    description:
      'Read a shared tab as an ARIA tree. Refs like e1 are only valid until the next snapshot.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'string' },
        maxChars: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_click',
    operation: 'act',
    description:
      'Click a snapshot ref. Requires action permission and the generation from the last snapshot.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'ref', 'generation'],
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string' },
        generation: { type: 'string' },
        kind: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_type',
    operation: 'act',
    description: 'Type into a snapshot ref. Requires action permission.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'ref', 'generation', 'text'],
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string' },
        generation: { type: 'string' },
        text: { type: 'string' },
        kind: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_open_tab',
    operation: 'tab.create',
    description: 'Open a new built-in browser tab on an http(s) address.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' } },
    },
  },
  {
    name: 'browser_navigate',
    operation: 'tab.navigate',
    description: 'Point an existing shared tab at a new address.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'url'],
      properties: {
        tabId: { type: 'string' },
        url: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_close_tab',
    operation: 'tab.close',
    description: 'Close a built-in browser tab.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: { tabId: { type: 'string' } },
    },
  },
  {
    name: 'browser_eval',
    operation: 'eval.run',
    description:
      'Run JavaScript on a shared tab. Every snippet is shown to the user first.',
    inputSchema: {
      type: 'object',
      required: ['tabId', 'code'],
      properties: {
        tabId: { type: 'string' },
        code: { type: 'string' },
      },
    },
  },
];

function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(pluginRoot, 'config.json'), 'utf8'));
    const grant = raw.defaultGrant;
    return {
      toolsEnabled: raw.toolsEnabled === true,
      evalEnabled: raw.evalEnabled === true,
      defaultGrant:
        grant === 'read' || grant === 'control' ? grant : 'none',
    };
  } catch {
    return { toolsEnabled: false, evalEnabled: false, defaultGrant: 'none' };
  }
}

function advertisedTools() {
  const config = readConfig();
  if (!config.toolsEnabled) return [];
  return allTools.filter(
    (tool) => tool.name !== 'browser_eval' || config.evalEnabled
  );
}

let framing = 'ndjson';
let stdinBuf = Buffer.alloc(0);

function send(message) {
  const json = JSON.stringify(message);
  if (framing === 'lsp') {
    const payload = Buffer.from(json, 'utf8');
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message, code = -32000) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callHost(capability, operation, input) {
  const url = process.env.VIBEX_HOST_CALL_URL ?? '';
  const token = process.env.VIBEX_HOST_CALL_TOKEN ?? '';
  if (!url || !token) {
    throw new Error(
      'host_call_unavailable: Host did not inject a plugin host.call connection; restart the Agent session after enabling the plugin'
    );
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ capability, operation, input }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message ?? `host_call_${response.status}`);
  }
  return body;
}

function negotiateProtocol(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)) {
    return requested;
  }
  return '2026-07-28';
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: negotiateProtocol(params?.protocolVersion),
      capabilities: { tools: {} },
      serverInfo: { name: 'vibex-browser', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return;
  }
  if (method === 'ping') {
    if (id != null) reply(id, {});
    return;
  }
  if (method === 'server/discover') {
    reply(id, { versions: SUPPORTED_PROTOCOLS });
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: advertisedTools() });
    return;
  }
  if (method === 'tools/call') {
    const config = readConfig();
    const name = params?.name;
    const tool = allTools.find((item) => item.name === name);
    if (!config.toolsEnabled || !tool) {
      fail(id, 'browser_tools_disabled');
      return;
    }
    if (tool.name === 'browser_eval' && !config.evalEnabled) {
      fail(id, 'browser_eval_disabled');
      return;
    }
    const args = { ...(params?.arguments ?? {}) };
    if (tool.name === 'browser_click') {
      args.kind = args.kind || 'click';
    }
    if (tool.name === 'browser_type') {
      args.kind = 'type';
    }
    if (
      tool.name === 'browser_open_tab' &&
      args.grant == null &&
      config.defaultGrant !== 'none'
    ) {
      args.grant = config.defaultGrant;
    }
    callHost('browser', tool.operation, args)
      .then((result) =>
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        })
      )
      .catch((error) =>
        fail(id, error instanceof Error ? error.message : String(error))
      );
    return;
  }
  if (id != null) {
    fail(id, `Method not found: ${String(method ?? '')}`, -32601);
  }
}

function consumeNdjson() {
  while (true) {
    const newline = stdinBuf.indexOf(0x0a);
    if (newline < 0) return;
    const line = stdinBuf
      .subarray(0, newline)
      .toString('utf8')
      .replace(/\r$/, '')
      .trim();
    stdinBuf = stdinBuf.subarray(newline + 1);
    if (!line || /^content-length:/i.test(line)) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      // Ignore a truncated or non-JSON line; the next frame may complete.
    }
  }
}

function consumeLsp() {
  while (true) {
    const headerEnd = stdinBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = stdinBuf.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) {
      stdinBuf = stdinBuf.subarray(headerEnd + 4);
      continue;
    }
    const size = Number(match[1]);
    const start = headerEnd + 4;
    if (stdinBuf.length < start + size) return;
    const body = stdinBuf.subarray(start, start + size).toString('utf8');
    stdinBuf = stdinBuf.subarray(start + size);
    try {
      handleMessage(JSON.parse(body));
    } catch {
      // Keep the server up if one frame is malformed.
    }
  }
}

function onStdin(chunk) {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (framing !== 'lsp') {
    const preview = stdinBuf
      .toString('utf8', 0, Math.min(stdinBuf.length, 64))
      .replace(/^\uFEFF/, '')
      .trimStart();
    if (/^content-length:/i.test(preview)) {
      framing = 'lsp';
    }
  }
  if (framing === 'lsp') consumeLsp();
  else consumeNdjson();
}

process.stdin.on('data', onStdin);
process.stdin.on('error', (error) => {
  try {
    process.stderr.write(`[vibex-browser] stdin ${error}\n`);
  } catch {
    // stderr may already be closed with the parent.
  }
});
process.on('uncaughtException', (error) => {
  try {
    process.stderr.write(
      `[vibex-browser] ${error instanceof Error ? error.stack : String(error)}\n`
    );
  } catch {
    // Keep the MCP process alive for the next request.
  }
});
process.stdin.resume();
