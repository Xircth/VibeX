import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { definePluginWorker } from './worker.js';

const originalStdin = process.stdin;
const originalStdout = process.stdout;

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: originalStdin });
  Object.defineProperty(process, 'stdout', { value: originalStdout });
  vi.resetModules();
});

describe('stdio worker protocol', () => {
  it('activates before invoking and returns protocol-safe responses', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (chunk) => {
      transcript += chunk.toString();
    });
    Object.defineProperty(process, 'stdin', { value: input });
    Object.defineProperty(process, 'stdout', { value: output });
    const { runStdioPluginWorker } = await import('./stdio.js');
    const run = runStdioPluginWorker(
      definePluginWorker((plugin) => {
        plugin.handle('echo.run', (value) => value);
      })
    );

    input.write(
      `${JSON.stringify({
        id: '1',
        method: 'activate',
        params: {
          pluginId: 'dev.vibex.echo',
          pluginVersion: '1.0.0',
          generation: 1,
          grantedCapabilities: [],
        },
      })}\n`
    );
    input.write(
      `${JSON.stringify({
        id: '2',
        method: 'invoke',
        params: { handler: 'echo.run', input: { value: 42 } },
      })}\n`
    );
    input.end();
    await run;

    expect(
      transcript
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      { id: '1', ok: true, result: { handlers: ['echo.run'] } },
      { id: '2', ok: true, result: { value: 42 } },
    ]);
  });

  it('keeps reading Host responses while a handler awaits a capability call', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(process, 'stdin', { value: input });
    Object.defineProperty(process, 'stdout', { value: output });
    output.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        messages.push(message);
        if (message.method === 'host.call') {
          input.write(
            `${JSON.stringify({ id: message.id, ok: true, result: { allowed: true } })}\n`
          );
        }
        if (message.id === '2' && message.ok === true) input.end();
      }
    });
    const { runStdioPluginWorker } = await import('./stdio.js');
    const run = runStdioPluginWorker(
      definePluginWorker((plugin, environment) => {
        plugin.handle('broker.run', () =>
          environment.host.call('runtime.execute', 'preview', {})
        );
      })
    );
    input.write(
      `${JSON.stringify({
        id: '1',
        method: 'activate',
        params: {
          pluginId: 'dev.vibex.broker',
          pluginVersion: '1.0.0',
          generation: 1,
          grantedCapabilities: ['runtime.execute'],
        },
      })}\n`
    );
    input.write(
      `${JSON.stringify({
        id: '2',
        method: 'invoke',
        params: { handler: 'broker.run', input: null },
      })}\n`
    );
    await run;
    expect(messages.at(-1)).toEqual({
      id: '2',
      ok: true,
      result: { allowed: true },
    });
  });
});
