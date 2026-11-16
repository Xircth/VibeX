import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  PROBE_OK,
  PromptCacheTtlTracker,
  isOfficialAnthropicSession,
  startClaudeNativeDriverStdioServer,
} from './claude-native-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_SCRIPT = path.join(__dirname, 'claude-native-driver.mjs');

function createHarness({ env = {}, sdkLoader, now, fetchImpl } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames = [];
  const waiters = [];

  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        const parsed = JSON.parse(line);
        frames.push(parsed);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i].predicate(parsed)) {
            const [{ resolve }] = waiters.splice(i, 1);
            resolve(parsed);
          }
        }
      }
      idx = buffer.indexOf('\n');
    }
  });

  const instance = startClaudeNativeDriverStdioServer({
    stdin,
    stdout,
    env,
    sdkLoader,
    now,
    fetchImpl,
  });

  function send(frame) {
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function waitFor(predicate, timeoutMs = 3_000) {
    const existing = frames.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for frame. Seen: ${JSON.stringify(frames)}`));
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  async function request(id, method, params = {}) {
    send({ jsonrpc: '2.0', id, method, params });
    return waitFor((frame) => frame.id === id);
  }

  async function close() {
    stdin.end();
    instance.readline.close();
  }

  return { frames, send, waitFor, request, close };
}

test('PromptCacheTtlTracker synthesizes 5m/1h expiry only for official Anthropic sessions and omits raw token counts', () => {
  let clock = 1_700_000_000_000;
  const tracker = new PromptCacheTtlTracker({
    officialSession: true,
    now: () => clock,
  });

  tracker.markRequestSent(clock);
  clock += 1_500;
  const created5m = tracker.observeUsage({
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 900,
    cache_read_input_tokens: 0,
  });

  assert.ok(created5m);
  assert.equal(created5m.cacheTtlTier, '5m');
  assert.equal(created5m.cacheEvent, 'created');
  assert.equal(
    created5m.promptCacheExpiresAt,
    new Date(1_700_000_000_000 + CACHE_TTL_5M_MS).toISOString()
  );
  // Ensure raw token counts are never leaked in synthesized status payloads.
  assert.equal('cache_creation_input_tokens' in created5m, false);
  assert.equal('cache_read_input_tokens' in created5m, false);
  assert.equal('input_tokens' in created5m, false);

  // Subsequent cache hit must preserve the original creation expiry timestamp.
  clock += 45_000;
  tracker.markRequestSent(clock);
  const hit5m = tracker.observeUsage({
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 900,
  });
  assert.ok(hit5m);
  assert.equal(hit5m.cacheEvent, 'hit');
  assert.equal(hit5m.promptCacheExpiresAt, created5m.promptCacheExpiresAt);

  // Explicit 1h tier updates expiry to requestSentAt + 1h.
  const sent1hAt = clock + 10_000;
  clock = sent1hAt;
  tracker.markRequestSent(sent1hAt);
  const created1h = tracker.observeUsage({
    cache_creation_input_tokens: 2048,
    cache_creation: { ephemeral_1h_input_tokens: 2048 },
  });
  assert.ok(created1h);
  assert.equal(created1h.cacheTtlTier, '1h');
  assert.equal(
    created1h.promptCacheExpiresAt,
    new Date(sent1hAt + CACHE_TTL_1H_MS).toISOString()
  );

  // Third-party proxy sessions must never synthesize promptCacheExpiresAt.
  assert.equal(
    isOfficialAnthropicSession({
      env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1' },
    }),
    false
  );
  assert.equal(
    isOfficialAnthropicSession({
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    }),
    true
  );

  const proxyTracker = new PromptCacheTtlTracker({
    officialSession: false,
    now: () => clock,
  });
  proxyTracker.markRequestSent(clock);
  assert.equal(
    proxyTracker.observeUsage({ cache_creation_input_tokens: 500 }),
    null
  );
});

test('initialize, prompt/send streaming, SDKRateLimitInfo, subagent lifecycle, hooks, and cache_status_updated work end-to-end', async () => {
  const capturedCalls = [];
  const fixedNow = 1_710_000_000_000;

  const mockSdk = {
    query({ prompt, options }) {
      capturedCalls.push({ prompt, options });
      return (async function* () {
        const firstInput = await prompt[Symbol.asyncIterator]().next();
        assert.equal(firstInput.value.type, 'user');

        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-sess-1',
          model: 'claude-sonnet-4-5',
          tools: ['Bash', 'Task'],
        };

        await options.hooks.Notification[0].hooks[0](
          { message: 'Indexing complete' },
          'hook-tool-1'
        );

        yield {
          type: 'assistant',
          session_id: 'claude-sess-1',
          uuid: 'msg-1',
          usage: {
            cache_creation_input_tokens: 1024,
            cache_read_input_tokens: 0,
          },
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'subagent-tu-1',
                name: 'Task',
                input: {
                  subagent_type: 'research',
                  description: 'Audit module boundaries',
                },
              },
            ],
          },
        };

        yield {
          type: 'stream_event',
          session_id: 'claude-sess-1',
          parent_tool_use_id: 'subagent-tu-1',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Inspecting crates...' },
          },
        };

        yield {
          type: 'user',
          session_id: 'claude-sess-1',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'subagent-tu-1',
                is_error: false,
                content: [{ type: 'text', text: 'Audit finished' }],
              },
            ],
          },
        };

        yield {
          type: 'rate_limit_event',
          session_id: 'claude-sess-1',
          rate_limit_info: {
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.82,
            requestsRemaining: 18,
            resetsAt: 1_710_003_600,
          },
        };

        yield {
          type: 'stream_event',
          session_id: 'claude-sess-1',
          uuid: 'msg-2',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'All checks green.' },
          },
        };

        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-sess-1',
          uuid: 'res-1',
          stop_reason: 'end_turn',
          result: 'All checks green.',
        };
      })();
    },
  };

  const harness = createHarness({
    sdkLoader: async () => mockSdk,
    now: () => fixedNow,
  });

  try {
    const initRes = await harness.request(1, 'initialize', {
      workspaceId: 'ws-1',
      workingDir: '/repo',
      model: 'claude-sonnet-4-5',
    });
    assert.equal(initRes.result.engineId, 'claude-native');
    assert.equal(initRes.result.officialAnthropicSession, true);

    const sendRes = await harness.request(2, 'prompt/send', {
      promptId: 'prompt-1',
      blocks: [{ type: 'text', text: 'Run full audit' }],
    });
    assert.equal(sendRes.result.accepted, true);

    await harness.waitFor(
      (f) => f.method === 'engine/event' && f.params?.kind === 'turn_completed'
    );

    const events = harness.frames
      .filter((f) => f.method === 'engine/event')
      .map((f) => f.params);

    assert.ok(events.some((e) => e.kind === 'hook_event' && e.hookName === 'Notification'));
    assert.ok(
      events.some(
        (e) =>
          e.kind === 'subagent/spawn' &&
          e.subagentId === 'subagent-tu-1' &&
          e.subagentType === 'research'
      )
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === 'subagent/update' &&
          e.subagentId === 'subagent-tu-1' &&
          e.textDelta === 'Inspecting crates...'
      )
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === 'subagent/complete' &&
          e.subagentId === 'subagent-tu-1' &&
          e.status === 'completed'
      )
    );

    const cacheEvt = events.find((e) => e.kind === 'cache_status_updated');
    assert.ok(cacheEvt);
    assert.equal(
      cacheEvt.cacheStatus.promptCacheExpiresAt,
      new Date(fixedNow + CACHE_TTL_5M_MS).toISOString()
    );

    const rateEvt = events.find((e) => e.kind === 'rate_limits_updated');
    assert.ok(rateEvt);
    assert.equal(
      rateEvt.rateLimits.resetAt,
      new Date(1_710_003_600 * 1000).toISOString()
    );
    assert.equal(rateEvt.rateLimits.requestsRemaining, 18);

    assert.ok(
      events.some(
        (e) =>
          e.kind === 'assistant_text_delta' && e.text === 'All checks green.'
      )
    );
    const completedEvt = events.find((e) => e.kind === 'turn_completed');
    assert.ok(completedEvt);
    assert.equal(completedEvt.served_model, 'claude-sonnet-4-5');
  } finally {
    await harness.close();
  }
});

test('canUseTool suspends until permission/respond resolves allow or deny, and prompt/steer injects in-flight user message', async () => {
  const receivedUserMessages = [];
  let permissionDecision = null;

  const mockSdk = {
    query({ prompt, options }) {
      return (async function* () {
        const iter = prompt[Symbol.asyncIterator]();
        const first = await iter.next();
        receivedUserMessages.push(first.value);

        permissionDecision = await options.canUseTool(
          'Bash',
          { command: 'rm -rf build' },
          { toolUseID: 'perm-bash-1', decisionReason: 'Destructive command' }
        );

        const steered = await iter.next();
        receivedUserMessages.push(steered.value);

        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-perm',
          result: 'Completed after steer',
        };
      })();
    },
  };

  const harness = createHarness({ sdkLoader: async () => mockSdk });

  try {
    await harness.request(1, 'initialize', {});
    await harness.request(2, 'prompt/send', {
      promptId: 'prompt-perm',
      sessionId: 'sess-perm',
      text: 'Clean build artifacts',
    });

    const permEvent = await harness.waitFor(
      (f) =>
        f.method === 'engine/event' && f.params?.kind === 'permission_requested'
    );
    assert.equal(permEvent.params.permissionId, 'perm-bash-1');
    assert.equal(permEvent.params.toolName, 'Bash');

    const permRes = await harness.request(3, 'permission/respond', {
      permissionId: 'perm-bash-1',
      decision: 'allow',
      updatedInput: { command: 'rm -rf dist' },
    });
    assert.equal(permRes.result.resolved, true);
    assert.equal(permRes.result.behavior, 'allow');

    const steerRes = await harness.request(4, 'prompt/steer', {
      expectedPromptId: 'prompt-perm',
      text: 'Also keep sourcemaps',
    });
    assert.equal(steerRes.result.status, 'accepted');

    await harness.waitFor(
      (f) => f.method === 'engine/event' && f.params?.kind === 'turn_completed'
    );

    assert.deepEqual(permissionDecision, {
      behavior: 'allow',
      updatedInput: { command: 'rm -rf dist' },
    });
    assert.equal(receivedUserMessages.length, 2);
    assert.equal(
      receivedUserMessages[1].message.content[0].text,
      'Also keep sourcemaps'
    );
  } finally {
    await harness.close();
  }
});

test('session/fork (forkSession) and session/revert (resumeSessionAt) stage exact SDK options and prompt/interrupt aborts active turn', async () => {
  const capturedOptions = [];
  let releaseHangingTurn;

  const mockSdk = {
    query({ options }) {
      capturedOptions.push(options);
      const handle = (async function* () {
        if (options.sessionId === 'sess-forked') {
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-forked',
            result: 'Forked turn ok',
          };
          return;
        }
        if (options.resumeSessionAt === 'msg-checkpoint-7') {
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-origin',
            result: 'Reverted turn ok',
          };
          return;
        }
        await new Promise((resolve) => {
          releaseHangingTurn = resolve;
          options.abortController.signal.addEventListener('abort', resolve, {
            once: true,
          });
        });
      })();
      handle.interrupt = async () => {
        if (options.abortController.signal.aborted) {
          throw new Error('Operation aborted');
        }
      };
      return handle;
    },
  };

  const harness = createHarness({ sdkLoader: async () => mockSdk });

  try {
    await harness.request(1, 'initialize', {});

    // 1. Fork session and verify next prompt/send receives forkSession + resume
    const forkRes = await harness.request(2, 'session/fork', {
      sessionId: 'sess-origin',
      newSessionId: 'sess-forked',
      resumeSessionAt: 'msg-branch-3',
    });
    assert.equal(forkRes.result.forked, true);

    await harness.request(3, 'prompt/send', {
      promptId: 'p-fork',
      sessionId: 'sess-forked',
      text: 'Continue on fork',
      waitForCompletion: true,
    });
    assert.equal(capturedOptions[0].forkSession, true);
    assert.equal(capturedOptions[0].resume, 'sess-origin');
    assert.equal(capturedOptions[0].sessionId, 'sess-forked');
    assert.equal(capturedOptions[0].resumeSessionAt, 'msg-branch-3');

    // 2. Revert session and verify next prompt/send receives resumeSessionAt
    const revertRes = await harness.request(4, 'session/revert', {
      sessionId: 'sess-origin',
      resumeSessionAt: 'msg-checkpoint-7',
    });
    assert.equal(revertRes.result.reverted, true);

    await harness.request(5, 'prompt/send', {
      promptId: 'p-revert',
      sessionId: 'sess-origin',
      text: 'Retry after rewind',
      waitForCompletion: true,
    });
    assert.equal(capturedOptions[1].resume, 'sess-origin');
    assert.equal(capturedOptions[1].resumeSessionAt, 'msg-checkpoint-7');

    // 3. Start hanging turn and verify prompt/interrupt aborts cleanly
    await harness.request(6, 'prompt/send', {
      promptId: 'p-hang',
      sessionId: 'sess-origin',
      text: 'Long running task',
    });
    const interruptRes = await harness.request(7, 'prompt/interrupt', {
      reason: 'user_cancelled',
    });
    assert.equal(interruptRes.result.interrupted, true);
    assert.equal(capturedOptions[2].abortController.signal.aborted, true);
    releaseHangingTurn?.();
  } finally {
    await harness.close();
  }
});

test('CLI subprocess --probe and DIMO_CLAUDE_SDK_PATH dynamic module resolution work over real OS pipes', async () => {
  const probeOutput = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER_SCRIPT, '--probe'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Probe exited with ${code}`));
      else resolve(out.trim());
    });
  });
  assert.equal(probeOutput, PROBE_OK);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-sdk-'));
  const mockSdkFile = path.join(tmpDir, 'mock-sdk.mjs');
  await fs.writeFile(
    mockSdkFile,
    `export function query() {
      return (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 'subproc-1', result: 'hello from subprocess' };
      })();
    }\n`,
    'utf8'
  );

  try {
    const child = spawn(process.execPath, [DRIVER_SCRIPT], {
      env: { ...process.env, DIMO_CLAUDE_SDK_PATH: mockSdkFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    const done = new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            const parsed = JSON.parse(line);
            lines.push(parsed);
            if (parsed.id === 99) {
              resolve();
            }
          }
          idx = buf.indexOf('\n');
        }
      });
      child.on('error', reject);
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'prompt/send',
        params: { promptId: 'sub-p1', text: 'Ping', waitForCompletion: true },
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: {} })}\n`
    );

    await done;
    child.kill();

    assert.ok(
      lines.some(
        (frame) =>
          frame.method === 'engine/event' &&
          frame.params?.kind === 'turn_completed' &&
          frame.params?.result === 'hello from subprocess'
      )
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('turn_completed captures assistant message.model as served_model and session/fork fails closed on empty checkpoint', async () => {
  const mockSdk = {
    query() {
      return (async function* () {
        yield {
          type: 'assistant',
          session_id: 'sess-model-check',
          uuid: 'msg-m1',
          message: {
            model: 'claude-sonnet-4-5-20250929',
            content: [{ type: 'text', text: 'Proxy downgraded response' }],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-model-check',
          uuid: 'res-m1',
          stop_reason: 'end_turn',
          result: 'Proxy downgraded response',
        };
      })();
    },
  };

  const harness = createHarness({ sdkLoader: async () => mockSdk });
  try {
    await harness.request(1, 'initialize', { model: 'claude-opus-4-6' });

    const invalidFork = await harness.request(2, 'session/fork', {
      sessionId: 'sess-model-check',
      resumeSessionAt: '   ',
    });
    assert.ok(invalidFork.error);
    assert.equal(invalidFork.error.code, -32602);

    await harness.request(3, 'prompt/send', {
      promptId: 'p-model',
      text: 'Check served model',
      waitForCompletion: true,
    });
    const completed = await harness.waitFor(
      (f) => f.method === 'engine/event' && f.params?.kind === 'turn_completed'
    );
    assert.equal(completed.params.served_model, 'claude-sonnet-4-5-20250929');
  } finally {
    await harness.close();
  }
});

test('standalone claude CLI fallback handles bidirectional stream-json, permissions, AskUserQuestion, TodoWrite, usage, placeholder stripping, and multi-turn resume', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-cli-'));
  const argsLogFile = path.join(tmpDir, 'cli-invocations.jsonl');
  const mockCliScript = path.join(tmpDir, 'mock-claude-cli.mjs');
  const isWindows = process.platform === 'win32';
  const mockCliEntry = isWindows
    ? path.join(tmpDir, 'mock-claude.cmd')
    : mockCliScript;

  await fs.writeFile(
    mockCliScript,
    `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLogFile)}, JSON.stringify(args) + '\\n');

const isResume = args.some((a) => a.startsWith('--resume='));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pendingControl = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

function requestControl(requestId, request) {
  return new Promise((resolve) => {
    pendingControl.set(requestId, resolve);
    send({ type: 'control_request', request_id: requestId, request });
  });
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          models: [{ value: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' }],
          commands: [{ name: 'compact' }, { name: 'review' }],
        },
      },
    });
    return;
  }
  if (msg.type === 'control_response') {
    const reqId = msg.response?.request_id;
    const resolver = pendingControl.get(reqId);
    if (resolver) {
      pendingControl.delete(reqId);
      resolver(msg.response);
    }
    return;
  }
  if (msg.type === 'user') {
    if (isResume) {
      send({
        type: 'stream_event',
        session_id: 'cli-sess-42',
        uuid: 'msg-r2',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Resumed turn ok' },
        },
      });
      send({
        type: 'result',
        subtype: 'success',
        session_id: 'cli-sess-42',
        uuid: 'res-r2',
        stop_reason: 'end_turn',
        result: 'Resumed turn ok',
      });
      setTimeout(() => process.exit(0), 20);
      return;
    }

    send({
      type: 'system',
      subtype: 'init',
      session_id: 'cli-sess-42',
      model: 'claude-opus-4-7',
      tools: ['Bash', 'AskUserQuestion', 'TodoWrite'],
      slash_commands: ['compact', 'review'],
    });

    const permResp = await requestControl('ctrl-perm-1', {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'tu-bash-1',
      input: { command: 'cargo test' },
      decision_reason: 'Needs shell execution',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
    });

    const questionResp = await requestControl('ctrl-q-1', {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-ask-1',
      input: {
        questions: [
          {
            question: 'Which profile?',
            header: 'Profile',
            multiSelect: false,
            options: [
              { label: 'Debug', description: 'Fast compile' },
              { label: 'Release', description: 'Optimized' },
            ],
          },
        ],
      },
    });

    send({
      type: 'assistant',
      session_id: 'cli-sess-42',
      uuid: 'msg-todo-1',
      message: {
        model: 'claude-opus-4-7',
        content: [
          {
            type: 'tool_use',
            id: 'tu-todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Verify CLI transport', status: 'in_progress', priority: 'high' },
              ],
            },
          },
        ],
      },
    });

    const chosenProfile =
      questionResp?.response?.updatedInput?.answers?.['Which profile?'] ?? 'unknown';
    const hasUpdatedPerms = Array.isArray(permResp?.response?.updatedPermissions);
    const reply = \`Profile=\${chosenProfile};Perms=\${hasUpdatedPerms}\`;

    send({
      type: 'stream_event',
      session_id: 'cli-sess-42',
      uuid: 'msg-stream-1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: reply },
      },
    });

    send({
      type: 'result',
      subtype: 'success',
      session_id: 'cli-sess-42',
      uuid: 'res-cli-1',
      stop_reason: 'end_turn',
      result: reply,
      total_cost_usd: 0.042,
      usage: {
        input_tokens: 1500,
        output_tokens: 250,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
      modelUsage: {
        'claude-opus-4-7': {
          inputTokens: 1500,
          outputTokens: 250,
          contextWindow: 200000,
        },
      },
    });
    setTimeout(() => process.exit(0), 20);
  }
});
`,
    { encoding: 'utf8', mode: 0o755 }
  );

  if (isWindows) {
    await fs.writeFile(
      mockCliEntry,
      `@echo off\r\n"${process.execPath}" "${mockCliScript}" %*\r\n`,
      'utf8'
    );
  }

  const extraDir = path.join(tmpDir, 'extra-workspace');
  await fs.mkdir(extraDir, { recursive: true });

  const harness = createHarness({
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: tmpDir,
      DIMO_FORCE_CLAUDE_CLI_FALLBACK: '1',
      CLAUDE_CODE_EXECUTABLE: mockCliEntry,
    },
  });

  try {
    const initRes = await harness.request(1, 'initialize', {
      workingDir: tmpDir,
      model: 'claude-opus-4-7',
      mcpServers: {
        companion: { command: 'node', args: ['mcp.js'] },
      },
      additionalDirectories: [extraDir],
    });
    assert.equal(initRes.result.transport, 'cli-fallback');

    // Turn 1 passes a placeholder sessionId ("prepared-*"), which must NOT be forwarded as --resume or --session-id.
    const sendRes = await harness.request(2, 'prompt/send', {
      promptId: 'cli-turn-1',
      sessionId: 'prepared-00000000-0000-0000-0000-000000000001',
      effort: 'high',
      text: 'Run checks',
    });
    assert.equal(sendRes.result.accepted, true);

    const permEvt = await harness.waitFor(
      (f) => f.method === 'engine/event' && f.params?.kind === 'permission_requested'
    );
    assert.equal(permEvt.params.toolName, 'Bash');
    await harness.request(3, 'permission/respond', {
      permissionId: permEvt.params.permissionId,
      decision: 'allow_always',
    });

    const questionEvt = await harness.waitFor(
      (f) => f.method === 'engine/event' && f.params?.kind === 'question_requested'
    );
    assert.equal(questionEvt.params.questions[0].question, 'Which profile?');
    await harness.request(4, 'question/respond', {
      requestId: questionEvt.params.requestId,
      answers: { 'Which profile?': 'Release' },
    });

    const done1 = await harness.waitFor(
      (f) =>
        f.method === 'engine/event' &&
        f.params?.kind === 'turn_completed' &&
        f.params?.promptId === 'cli-turn-1'
    );
    assert.equal(done1.params.result, 'Profile=Release;Perms=true');

    const events = harness.frames
      .filter((f) => f.method === 'engine/event')
      .map((f) => f.params);
    const planEvt = events.find((e) => e.kind === 'plan_updated');
    assert.ok(planEvt);
    assert.equal(planEvt.entries[0].content, 'Verify CLI transport');

    const usageEvt = events.find(
      (e) => e.kind === 'usage_updated' && e.usage?.totalCostUsd === 0.042
    );
    assert.ok(usageEvt);
    assert.equal(usageEvt.usage.inputTokens, 1500);
    assert.equal(usageEvt.usage.outputTokens, 250);
    assert.equal(usageEvt.usage.contextWindow, 200000);

    // Turn 2 reuses the established real session 'cli-sess-42' -> must pass --resume=cli-sess-42
    await harness.request(5, 'prompt/send', {
      promptId: 'cli-turn-2',
      sessionId: 'cli-sess-42',
      text: 'Follow up',
      waitForCompletion: true,
    });

    const invocationsRaw = await fs.readFile(argsLogFile, 'utf8');
    const invocations = invocationsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2);

    const turn1Args = invocations[0];
    assert.ok(turn1Args.includes('--print'));
    assert.ok(turn1Args.includes('--permission-prompt-tool=stdio'));
    assert.ok(turn1Args.includes('--model=claude-opus-4-7'));
    assert.ok(turn1Args.includes('--effort=high'));
    assert.ok(turn1Args.includes('--mcp-config'));
    assert.ok(turn1Args.some((a) => a.startsWith('--add-dir=')));
    assert.equal(
      turn1Args.some((a) => a.includes('prepared-')),
      false
    );

    const turn2Args = invocations[1];
    assert.ok(turn2Args.includes('--resume=cli-sess-42'));

    await harness.request(99, 'shutdown', {});
  } finally {
    await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('initialize fails immediately when neither @anthropic-ai/claude-agent-sdk nor standalone claude CLI is available', async () => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-no-claude-'));
  const harness = createHarness({
    env: {
      DIMO_FORCE_CLAUDE_CLI_FALLBACK: '1',
      PATH: emptyDir,
      Path: emptyDir,
      HOME: emptyDir,
      USERPROFILE: emptyDir,
      APPDATA: emptyDir,
      LOCALAPPDATA: emptyDir,
    },
  });

  try {
    const initRes = await harness.request(1, 'initialize', {
      workingDir: emptyDir,
    });
    assert.ok(initRes.error);
    assert.match(initRes.error.message, /Claude runtime not found/i);
  } finally {
    await harness.close();
    await fs.rm(emptyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('agent-sdk mode unwraps npm claude.cmd to bundled bin/claude.exe or cli.js instead of passing .cmd directly to sdk.query', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-npm-shim-'));
  const npmBinDir = path.join(tmpDir, 'npm');
  const pkgBinDir = path.join(npmBinDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  await fs.mkdir(pkgBinDir, { recursive: true });

  const shimCmd = path.join(npmBinDir, 'claude.cmd');
  const realBinExe = path.join(pkgBinDir, 'claude.exe');
  await fs.writeFile(shimCmd, '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n', 'utf8');
  await fs.writeFile(realBinExe, 'MZ-fake-pe-binary', 'utf8');

  let capturedOptions = null;
  const mockSdk = {
    query({ options }) {
      capturedOptions = options;
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-unwrapped-exe',
          stop_reason: 'end_turn',
          result: 'ok',
        };
      })();
    },
  };

  const harness = createHarness({
    env: { CLAUDE_CODE_EXECUTABLE: shimCmd },
    sdkLoader: async () => mockSdk,
  });

  try {
    await harness.request(1, 'initialize', { workingDir: tmpDir });
    const sendRes = await harness.request(2, 'prompt/send', {
      promptId: 'prompt-unwrap-1',
      text: 'hello',
      waitForCompletion: true,
    });
    assert.equal(sendRes.error, undefined);
    assert.equal(capturedOptions.pathToClaudeCodeExecutable, realBinExe);
  } finally {
    await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('agent-sdk mode never triggers spawn EINVAL when CLAUDE_CODE_EXECUTABLE points to a custom .cmd wrapper on Windows', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-cmd-sdk-'));
  const isWindows = process.platform === 'win32';
  const mockScript = path.join(tmpDir, 'mock-sdk-cli.mjs');
  const customWrapper = isWindows ? path.join(tmpDir, 'custom-claude.cmd') : mockScript;

  await fs.writeFile(
    mockScript,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-cmd-sdk',
      stop_reason: 'end_turn',
      result: 'Custom wrapper ok',
    }) + '\\n');
    setTimeout(() => process.exit(0), 10);
  }
});
`,
    { encoding: 'utf8', mode: 0o755 }
  );

  if (isWindows) {
    await fs.writeFile(
      customWrapper,
      `@echo off\r\n"${process.execPath}" "${mockScript}" %*\r\n`,
      'utf8'
    );
  }

  // Mirrors @anthropic-ai/claude-agent-sdk's ProcessTransport.initialize():
  // treats non-.js/.mjs paths as native binaries and calls child_process.spawn()
  // directly without shell unless options.spawnClaudeCodeProcess is provided.
  const realisticAgentSdk = {
    query({ prompt, options }) {
      const target = options.pathToClaudeCodeExecutable;
      const isJs = ['.js', '.mjs', '.tsx', '.ts', '.jsx'].some((ext) => target.endsWith(ext));
      const command = isJs ? process.execPath : target;
      const args = isJs
        ? [target, '--output-format', 'stream-json', '--input-format', 'stream-json']
        : ['--output-format', 'stream-json', '--input-format', 'stream-json'];
      const child = options.spawnClaudeCodeProcess
        ? options.spawnClaudeCodeProcess({ command, args, cwd: options.cwd, env: options.env })
        : spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });

      return (async function* () {
        const first = await prompt[Symbol.asyncIterator]().next();
        child.stdin.write(`${JSON.stringify(first.value)}\n`);
        let stdoutBuf = '';
        for await (const chunk of child.stdout) {
          stdoutBuf += chunk.toString('utf8');
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) yield JSON.parse(line.trim());
          }
        }
      })();
    },
  };

  const harness = createHarness({
    env: { CLAUDE_CODE_EXECUTABLE: customWrapper },
    sdkLoader: async () => realisticAgentSdk,
  });

  try {
    await harness.request(1, 'initialize', { workingDir: tmpDir });
    const sendRes = await harness.request(2, 'prompt/send', {
      promptId: 'prompt-cmd-sdk-1',
      text: 'ping',
      waitForCompletion: true,
    });
    assert.equal(sendRes.error, undefined, `unexpected RPC error: ${JSON.stringify(sendRes.error)}`);
    assert.equal(sendRes.result.accepted, true);
  } finally {
    await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('agent-sdk mode retries with unwrapped standalone claude binary when optional SDK platform binary is absent', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-omit-opt-'));
  const npmBinDir = path.join(tmpDir, 'npm');
  const pkgBinDir = path.join(npmBinDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  await fs.mkdir(pkgBinDir, { recursive: true });

  const shimCmd = path.join(npmBinDir, 'claude.cmd');
  const realBinExe = path.join(pkgBinDir, 'claude.exe');
  await fs.writeFile(shimCmd, '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n', 'utf8');
  await fs.writeFile(realBinExe, 'MZ-fake-pe-binary', 'utf8');
  if (process.platform !== 'win32') {
    const unixBin = path.join(npmBinDir, 'claude');
    await fs.writeFile(unixBin, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  }

  let calls = 0;
  let secondCallExecutable = null;
  const omitOptionalSdk = {
    query({ options }) {
      calls += 1;
      if (!options.pathToClaudeCodeExecutable) {
        throw new Error(
          `Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`
        );
      }
      secondCallExecutable = options.pathToClaudeCodeExecutable;
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-omit-opt',
          stop_reason: 'end_turn',
          result: 'ok',
        };
      })();
    },
  };

  const harness = createHarness({
    env: {
      PATH: npmBinDir,
      Path: npmBinDir,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      APPDATA: tmpDir,
      LOCALAPPDATA: tmpDir,
    },
    sdkLoader: async () => omitOptionalSdk,
  });

  try {
    await harness.request(1, 'initialize', { workingDir: tmpDir });
    const sendRes = await harness.request(2, 'prompt/send', {
      promptId: 'prompt-omit-opt-1',
      text: 'hello',
      waitForCompletion: true,
    });
    assert.equal(sendRes.error, undefined);
    assert.equal(calls, 2);
    if (process.platform === 'win32') {
      assert.equal(secondCallExecutable, realBinExe);
    } else {
      assert.ok(secondCallExecutable);
    }
  } finally {
    await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('discoverClaudeModels merges gateway /v1/models, query().supportedModels(), and settings.json env, prioritizes concrete models, and marks isDefault', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-models-'));
  await fs.writeFile(
    path.join(tmpDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'tok-test-only',
        ANTHROPIC_MODEL: 'claude-opus-5-5',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5-2',
      },
    }),
    'utf8'
  );

  let seenUrl = null;
  let seenAuth = null;
  let probeClosed = false;
  let probeAborted = false;

  const mockSdk = {
    __supportsQueryModelProbe: true,
    query({ prompt, options }) {
      const isWarmProbe = prompt && typeof prompt[Symbol.asyncIterator] === 'function' && !options?.permissionPromptToolName && !options?.canUseTool && options?.settingSources;
      if (isWarmProbe) {
        options.abortController?.signal?.addEventListener('abort', () => {
          probeAborted = true;
        });
        return {
          async supportedModels() {
            return [
              { value: 'sonnet', displayName: 'Sonnet (Latest Alias)' },
              { value: 'claude-fable-5-2', displayName: 'claude-fable-5-2' },
              { value: 'opus', displayName: 'Opus (Latest Alias)' },
            ];
          },
          close() {
            probeClosed = true;
          },
        };
      }
      throw new Error('Unexpected query invocation');
    },
  };

  const harness = createHarness({
    env: { CLAUDE_CONFIG_DIR: tmpDir },
    sdkLoader: async () => mockSdk,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.Authorization ?? null;
      return {
        ok: true,
        async json() {
          return {
            data: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }],
          };
        },
      };
    },
  });

  try {
    const initRes = await harness.request(1, 'initialize', { workingDir: tmpDir });
    assert.equal(initRes.error, undefined);
    assert.equal(seenUrl, 'https://gateway.example/anthropic/v1/models');
    assert.equal(seenAuth, 'Bearer tok-test-only');
    assert.equal(initRes.result.officialAnthropicSession, false);
    assert.equal(probeAborted, true);
    assert.equal(probeClosed, true);

    const models = initRes.result.models;
    const ids = models.map((m) => m.value);
    assert.deepEqual(ids, [
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
      'claude-sonnet-5-5',
      'sonnet',
      'opus',
    ]);
    assert.equal(models.find((m) => m.value === 'claude-opus-5-5')?.displayName, 'Claude Opus 5.5');
    assert.equal(models.find((m) => m.value === 'claude-opus-5-5')?.isDefault, true);
    assert.equal(models.find((m) => m.value === 'claude-fable-5-2')?.displayName, 'Claude Fable 5.2');
    assert.equal(models.find((m) => m.value === 'claude-sonnet-5-5')?.displayName, 'Claude Sonnet 5.5');
    assert.equal(models.find((m) => m.value === 'sonnet')?.isDefault, undefined);
  } finally {
    await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('effectiveEnv does not inject ANTHROPIC_API_KEY when ANTHROPIC_AUTH_TOKEN is already set', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dimo-claude-auth-guard-'));
  let capturedEnv = null;
  const mockSdk = {
    query({ options }) {
      capturedEnv = options.env;
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-auth-guard',
          stop_reason: 'end_turn',
          result: 'ok',
        };
      })();
    },
  };

  const harness = createHarness({
    env: {
      CLAUDE_CONFIG_DIR: tmpDir,
      ANTHROPIC_AUTH_TOKEN: 'tok-existing',
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    },
    sdkLoader: async () => mockSdk,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });

  try {
    const initRes = await harness.request(1, 'initialize', {
      workingDir: tmpDir,
      auth: { apiKey: 'sk-should-not-override-token' },
    });
    assert.equal(initRes.error, undefined);
    const sendRes = await harness.request(2, 'prompt/send', {
      promptId: 'prompt-auth-guard',
      text: 'hi',
      waitForCompletion: true,
    });
    assert.equal(sendRes.error, undefined);
    assert.equal(capturedEnv.ANTHROPIC_AUTH_TOKEN, 'tok-existing');
    assert.equal(capturedEnv.ANTHROPIC_API_KEY, undefined);
  } finally {
    await harness.close();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
