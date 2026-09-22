#!/usr/bin/env node
/**
 * MCP stdio server for built-in browser tools.
 * Host injects VIBEX_HOST_CALL_* when projecting this content.mcp.
 * Framing is newline-delimited JSON-RPC (MCP stdio). Tools are advertised
 * only while config.json toolsEnabled is true; eval is a separate switch.
 * Grant checks stay in Host BrowserService.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
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
    return {
      toolsEnabled: raw.toolsEnabled === true,
      evalEnabled: raw.evalEnabled === true,
    };
  } catch {
    return { toolsEnabled: false, evalEnabled: false };
  }
}

function advertisedTools() {
  const config = readConfig();
  if (!config.toolsEnabled) return [];
  return allTools.filter(
    (tool) => tool.name !== 'browser_eval' || config.evalEnabled
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
  return '2025-03-26';
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

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleMessage(message);
});
