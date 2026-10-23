#!/usr/bin/env node
import { callDaemon } from './daemon-client.mjs';

const FALLBACK_TOOLS = [
  {
    name: 'computer_list_apps',
    description:
      'List desktop applications installed or running on this computer that may be launched or inspected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_list_windows',
    description:
      'List currently shared desktop windows and their targetIds, bounds, and grant levels.',
    inputSchema: {
      type: 'object',
      properties: { pid: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_snapshot',
    description:
      'Read the accessibility tree of a shared window, assigning numeric element refs (@N) for subsequent actions.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        root: { type: 'string' },
        depth: { type: 'integer' },
        maxChars: { type: 'integer' },
        filter: { type: 'string', enum: ['all', 'interactive'] },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_screenshot',
    description: 'Capture a PNG screenshot of a shared window or screen.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        maxDimension: { type: 'integer' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_verify',
    description:
      'Check a condition against the live accessibility tree of a shared window without returning the full tree.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        kind: { type: 'string' },
        role: { type: 'string' },
        title: { type: 'string' },
        value: { type: 'string' },
        element: { type: 'string' },
        count: { type: 'integer' },
        comparison: { type: 'string' },
      },
      required: ['targetId', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_click',
    description:
      'Click an element (@N) or window-local coordinates (x, y) inside a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        element: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'integer' },
        modifiers: { type: 'array', items: { type: 'string' } },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_drag',
    description:
      'Drag between elements or coordinates inside a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        fromElement: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toElement: { type: 'string' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        modifiers: { type: 'array', items: { type: 'string' } },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_scroll',
    description: 'Scroll inside a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        element: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        unit: { type: 'string', enum: ['line', 'pixel'] },
        modifiers: { type: 'array', items: { type: 'string' } },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_type',
    description: 'Type text into a window or element shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        element: { type: 'string' },
        text: { type: 'string' },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_press_key',
    description: 'Press a key or key chord in a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        element: { type: 'string' },
        key: { type: 'string' },
        repeat: { type: 'integer' },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_hold_key',
    description:
      'Hold a key or key chord down for a duration in milliseconds in a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        element: { type: 'string' },
        key: { type: 'string' },
        durationMs: { type: 'integer' },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId', 'key', 'durationMs'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_set_value',
    description:
      'Set the accessibility value of an element (@N) directly in a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        element: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['targetId', 'element', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_restore',
    description: 'Unminimize or restore a minimized window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_invoke_menu',
    description:
      'Invoke a menu bar item by path in a window shared for Control.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        path: { type: 'array', items: { type: 'string' } },
        delivery: { type: 'string', enum: ['background', 'foreground'] },
      },
      required: ['targetId', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_launch_app',
    description: 'Launch an application by name or key when allowed by settings.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        key: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_set_window_frame',
    description:
      'Move or resize a window shared for Control when allowed by settings.',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_clipboard_read',
    description: 'Read text from the clipboard when allowed by settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_clipboard_write',
    description: 'Write text to the clipboard when allowed by settings.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;

  if (method === 'initialize') {
    const requested = params && params.protocolVersion;
    const protocolVersion = [
      '2024-11-05',
      '2025-03-26',
      '2025-11-25',
      '2026-07-28',
    ].includes(requested)
      ? requested
      : '2026-07-28';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'vibex-computer-use',
          version: '0.34.0',
        },
      },
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    try {
      const res = await callDaemon(null, 'mcp.listTools', {});
      const tools =
        res && Array.isArray(res.tools) && res.tools.length > 0
          ? res.tools
          : FALLBACK_TOOLS;
      send({ jsonrpc: '2.0', id, result: { tools } });
    } catch {
      send({ jsonrpc: '2.0', id, result: { tools: FALLBACK_TOOLS } });
    }
    return;
  }

  if (method === 'tools/call') {
    const toolName = params && typeof params.name === 'string' ? params.name : '';
    const args =
      params && params.arguments && typeof params.arguments === 'object'
        ? params.arguments
        : {};
    try {
      const result = await callDaemon(null, 'mcp.callTool', {
        name: toolName,
        arguments: args,
      });
      send({
        jsonrpc: '2.0',
        id,
        result: result ?? {
          content: [{ type: 'text', text: 'Empty tool response' }],
          isError: true,
        },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        },
      });
    }
    return;
  }

  if (id != null) {
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${String(method || '')}`,
      },
    });
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) break;
    const line = buf.subarray(0, nl).toString('utf8').trim();
    buf = buf.subarray(nl + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      void handle(parsed);
    } catch {
      // ignore malformed input lines
    }
  }
});
process.stdin.resume();
