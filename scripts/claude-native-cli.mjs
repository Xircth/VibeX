import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { readFiniteNumber, readString } from './claude-native-events.mjs';

const IS_WINDOWS = process.platform === 'win32';
const MAX_STDERR_TAIL_CHARS = 4096;

function isWindowsAppExecutionAlias(candidate) {
  const normalized = String(candidate).replace(/\//g, '\\').toLowerCase();
  return normalized.includes('\\microsoft\\windowsapps\\');
}

function fileExists(candidate) {
  if (!candidate || isWindowsAppExecutionAlias(candidate)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function isWindowsBatchScript(candidate) {
  if (!candidate) return false;
  const lower = String(candidate).toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * Unwraps a Windows `.cmd` / `.bat` npm shim to a directly Node-spawnable executable
 * (`<stem>.exe`, `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, or `cli.js`)
 * whenever present, avoiding Node CVE-2024-27980 `spawn EINVAL` and extra `cmd.exe` hops.
 */
export function unwrapClaudeCliExecutable(candidate) {
  const cleaned = readString(candidate);
  if (!cleaned) return null;

  if (isWindowsBatchScript(cleaned)) {
    const dir = path.dirname(cleaned);
    const stem = path.basename(cleaned, path.extname(cleaned));
    const directCandidates = [
      path.join(dir, `${stem}.exe`),
      path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(dir, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      path.join(dir, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ];
    for (const direct of directCandidates) {
      if (fileExists(direct)) return direct;
    }
  }

  return fileExists(cleaned) ? cleaned : null;
}

function candidateBinaryNames(baseName = 'claude') {
  return IS_WINDOWS
    ? [`${baseName}.exe`, `${baseName}.cmd`, `${baseName}.bat`, baseName]
    : [baseName];
}

function searchPathDirectories(env = process.env) {
  const dirs = [];
  const rawPath = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
  for (const segment of String(rawPath).split(path.delimiter)) {
    const trimmed = segment.trim();
    if (trimmed) dirs.push(trimmed);
  }

  const home = readString(env?.USERPROFILE ?? env?.HOME) ?? os.homedir();
  if (home) {
    dirs.push(path.join(home, '.local', 'bin'));
    dirs.push(path.join(home, '.claude', 'local'));
    dirs.push(path.join(home, '.npm-global', 'bin'));
  }

  if (IS_WINDOWS) {
    const appData = readString(env?.APPDATA) ?? (home ? path.join(home, 'AppData', 'Roaming') : null);
    const localAppData =
      readString(env?.LOCALAPPDATA) ?? (home ? path.join(home, 'AppData', 'Local') : null);
    if (appData) dirs.push(path.join(appData, 'npm'));
    if (localAppData) {
      dirs.push(path.join(localAppData, 'Programs', 'claude'));
      dirs.push(path.join(localAppData, 'AnthropicClaude'));
      dirs.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links'));
    }
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }

  return dirs;
}

export function resolveClaudeCliExecutable({ env = process.env, options = {} } = {}) {
  const explicitCandidates = [
    readString(options?.pathToClaudeCodeExecutable),
    readString(env?.CLAUDE_CODE_EXECUTABLE),
    readString(env?.DIMO_CLAUDE_PATH),
    readString(env?.CLAUDE_PATH),
  ].filter(Boolean);

  const searchDirs = searchPathDirectories(env);

  for (const explicit of explicitCandidates) {
    const unwrapped = unwrapClaudeCliExecutable(explicit);
    if (unwrapped) return unwrapped;
    if (!path.isAbsolute(explicit) && !explicit.includes('/') && !explicit.includes('\\')) {
      for (const dir of searchDirs) {
        for (const name of candidateBinaryNames(explicit)) {
          const resolved = unwrapClaudeCliExecutable(path.join(dir, name));
          if (resolved) return resolved;
        }
      }
    }
  }

  let batchFallback = null;
  for (const dir of searchDirs) {
    for (const name of candidateBinaryNames('claude')) {
      const resolved = unwrapClaudeCliExecutable(path.join(dir, name));
      if (!resolved) continue;
      if (!isWindowsBatchScript(resolved)) return resolved;
      if (!batchFallback) batchFallback = resolved;
    }
  }

  return batchFallback;
}

export function buildClaudeCliArgs(options = {}) {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
  ];

  if (options.includePartialMessages !== false) {
    args.push('--include-partial-messages');
  }
  if (options.includeHookEvents) {
    args.push('--include-hook-events');
  }
  if (typeof options.canUseTool === 'function') {
    args.push('--permission-prompt-tool=stdio');
  }

  const model = readString(options.model);
  if (model) args.push(`--model=${model}`);

  const effort = readString(options.effort);
  if (effort) args.push(`--effort=${effort}`);

  const permissionMode = readString(options.permissionMode);
  if (permissionMode) args.push(`--permission-mode=${permissionMode}`);

  if (
    options.allowDangerouslySkipPermissions === true ||
    permissionMode === 'bypassPermissions'
  ) {
    args.push('--allow-dangerously-skip-permissions');
  }

  const resume = readString(options.resume);
  if (resume) args.push(`--resume=${resume}`);

  if (options.forkSession === true) {
    args.push('--fork-session');
  }

  const resumeSessionAt = readString(options.resumeSessionAt);
  if (resumeSessionAt) args.push(`--resume-session-at=${resumeSessionAt}`);

  const sessionId = readString(options.sessionId);
  if (sessionId) args.push(`--session-id=${sessionId}`);

  const maxTurns = readFiniteNumber(options.maxTurns);
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push(`--max-turns=${Math.trunc(maxTurns)}`);
  }

  if (
    options.mcpServers &&
    typeof options.mcpServers === 'object' &&
    !Array.isArray(options.mcpServers) &&
    Object.keys(options.mcpServers).length > 0
  ) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: options.mcpServers }));
  }

  if (Array.isArray(options.additionalDirectories)) {
    for (const rawDir of options.additionalDirectories) {
      const dir = readString(rawDir);
      if (dir) args.push(`--add-dir=${dir}`);
    }
  }

  return args;
}

function quoteWindowsCmdArg(arg) {
  const str = String(arg);
  if (!/[\s"&|<>^()]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

export function resolveSpawnCommand(executable, cliArgs) {
  const unwrapped = unwrapClaudeCliExecutable(executable) ?? executable;
  const lower = unwrapped.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return {
      command: process.execPath,
      args: [unwrapped, ...cliArgs],
      windowsVerbatimArguments: false,
    };
  }
  if (IS_WINDOWS && isWindowsBatchScript(unwrapped)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const cmdLine = [quoteWindowsCmdArg(unwrapped), ...cliArgs.map(quoteWindowsCmdArg)].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `"${cmdLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: unwrapped, args: cliArgs, windowsVerbatimArguments: false };
}

export function spawnClaudeProcess({ command, args = [], cwd, env, signal }) {
  const resolved = resolveSpawnCommand(command, args);
  return spawn(resolved.command, resolved.args, {
    cwd,
    env,
    ...(signal ? { signal } : {}),
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

class AsyncMessageQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
    this.failure = null;
  }

  push(item) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  fail(error) {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift().reject(error);
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift().resolve({ value: undefined, done: true });
    }
  }

  next() {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift(), done: false });
    }
    if (this.failure) {
      const err = this.failure;
      this.failure = null;
      return Promise.reject(err);
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

export function createClaudeCliSdkFallback({
  claudeExecutable: defaultExecutable,
  env: baseEnv = process.env,
} = {}) {
  const verifiedDefault =
    unwrapClaudeCliExecutable(defaultExecutable) ?? resolveClaudeCliExecutable({ env: baseEnv });
  if (!verifiedDefault) {
    throw new Error(
      'Claude runtime not found: neither @anthropic-ai/claude-agent-sdk nor standalone `claude` CLI is installed'
    );
  }

  return {
    isCliFallback: true,
    claudeExecutable: verifiedDefault,

    query({ prompt, options = {} } = {}) {
      const mergedEnv = {
        ...baseEnv,
        ...(options.env && typeof options.env === 'object' ? options.env : {}),
      };
      delete mergedEnv.NODE_OPTIONS;
      if (!mergedEnv.CLAUDE_CODE_ENTRYPOINT) {
        mergedEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
      }
      if (!mergedEnv.CLAUDE_CODE_SDK_READS_SESSION_STATE) {
        mergedEnv.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1';
      }
      if (options.enableFileCheckpointing !== false) {
        mergedEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true';
      }

      const executable =
        resolveClaudeCliExecutable({ env: mergedEnv, options }) ?? verifiedDefault;
      const cliArgs = buildClaudeCliArgs(options);
      const cwd = readString(options.cwd) ?? process.cwd();

      const child =
        typeof options.spawnClaudeCodeProcess === 'function'
          ? options.spawnClaudeCodeProcess({ command: executable, args: cliArgs, cwd, env: mergedEnv })
          : spawnClaudeProcess({ command: executable, args: cliArgs, cwd, env: mergedEnv });

      const queue = new AsyncMessageQueue();
      const pendingControlResponses = new Map();
      const inFlightControlAborts = new Map();
      let stderrTail = '';
      let controlSeq = 0;
      let stdinClosed = false;
      let closed = false;
      let resultReceived = false;
      let promptPumpFinished = false;
      let latestSessionId = readString(options.resume ?? options.sessionId) ?? '';
      const isSingleStringPrompt = typeof prompt === 'string';

      function writeLine(payload) {
        if (stdinClosed || !child.stdin || child.stdin.destroyed) return false;
        try {
          child.stdin.write(`${JSON.stringify(payload)}\n`);
          return true;
        } catch {
          return false;
        }
      }

      function endStdin() {
        if (stdinClosed) return;
        stdinClosed = true;
        try {
          child.stdin?.end();
        } catch {
          // Ignore broken pipe on exit.
        }
      }

      function maybeFinishStdinAfterResult() {
        if (
          resultReceived &&
          inFlightControlAborts.size === 0 &&
          (isSingleStringPrompt || promptPumpFinished)
        ) {
          endStdin();
        }
      }

      function sendControlRequest(requestBody, timeoutMs = 4000) {
        const requestId = `ctrl-${++controlSeq}-${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve, reject) => {
          const timer =
            timeoutMs > 0
              ? setTimeout(() => {
                  pendingControlResponses.delete(requestId);
                  reject(new Error(`Claude CLI control_request (${requestBody.subtype}) timed out`));
                }, timeoutMs)
              : null;
          timer?.unref?.();

          pendingControlResponses.set(requestId, {
            resolve: (res) => {
              if (timer) clearTimeout(timer);
              resolve(res);
            },
            reject: (err) => {
              if (timer) clearTimeout(timer);
              reject(err);
            },
          });

          if (!writeLine({ request_id: requestId, type: 'control_request', request: requestBody })) {
            pendingControlResponses.delete(requestId);
            if (timer) clearTimeout(timer);
            reject(new Error('Claude CLI stdin is closed'));
          }
        });
      }

      async function handleIncomingControlRequest(frame) {
        const requestId = frame.request_id;
        const req = frame.request ?? {};
        if (!requestId || inFlightControlAborts.has(requestId)) return;

        const controller = new AbortController();
        inFlightControlAborts.set(requestId, controller);

        try {
          let responsePayload = {};
          if (req.subtype === 'can_use_tool') {
            if (typeof options.canUseTool !== 'function') {
              throw new Error('canUseTool callback is not configured');
            }
            const decision = await options.canUseTool(
              req.tool_name,
              req.input && typeof req.input === 'object' ? req.input : {},
              {
                signal: controller.signal,
                suggestions: req.permission_suggestions,
                blockedPath: req.blocked_path,
                decisionReason: req.decision_reason,
                title: req.title,
                displayName: req.display_name,
                description: req.description,
                toolUseID: req.tool_use_id,
                agentID: req.agent_id,
                requestId,
              }
            );
            const toolUseID = readString(req.tool_use_id);
            if (decision?.behavior === 'allow') {
              responsePayload = {
                behavior: 'allow',
                updatedInput:
                  decision.updatedInput && typeof decision.updatedInput === 'object'
                    ? decision.updatedInput
                    : req.input ?? {},
                ...(Array.isArray(decision.updatedPermissions) &&
                decision.updatedPermissions.length > 0
                  ? { updatedPermissions: decision.updatedPermissions }
                  : {}),
                ...(toolUseID ? { toolUseID } : {}),
              };
            } else {
              responsePayload = {
                behavior: 'deny',
                message: readString(decision?.message) ?? 'Permission denied by user',
                ...(decision?.interrupt === true ? { interrupt: true } : {}),
                ...(toolUseID ? { toolUseID } : {}),
              };
            }
          } else if (req.subtype === 'hook_callback') {
            responsePayload = { continue: true };
          } else if (req.subtype === 'elicitation') {
            if (typeof options.onElicitation === 'function') {
              responsePayload =
                (await options.onElicitation(req, { signal: controller.signal, requestId })) ?? {
                  action: 'decline',
                };
            } else {
              responsePayload = { action: 'decline' };
            }
          }

          writeLine({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: responsePayload,
            },
          });
        } catch (err) {
          writeLine({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: requestId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        } finally {
          inFlightControlAborts.delete(requestId);
          maybeFinishStdinAfterResult();
        }
      }

      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARS);
          if (typeof options.stderr === 'function') options.stderr(chunk);
        });
      }

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (rawLine) => {
        const trimmed = rawLine.trim();
        if (!trimmed || !trimmed.startsWith('{')) return;
        let frame;
        try {
          frame = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!frame || typeof frame !== 'object') return;

        const observedSid = readString(frame.session_id ?? frame.sessionId);
        if (observedSid) latestSessionId = observedSid;

        if (frame.type === 'control_response') {
          const resp = frame.response ?? {};
          const waiter = pendingControlResponses.get(resp.request_id);
          if (waiter) {
            pendingControlResponses.delete(resp.request_id);
            if (resp.subtype === 'error') {
              waiter.reject(new Error(readString(resp.error) ?? 'Claude CLI control error'));
            } else {
              waiter.resolve(resp.response ?? resp);
            }
          }
          return;
        }

        if (frame.type === 'control_request') {
          void handleIncomingControlRequest(frame);
          return;
        }

        if (frame.type === 'control_cancel_request') {
          const ctrl = inFlightControlAborts.get(frame.request_id);
          if (ctrl) {
            ctrl.abort();
            inFlightControlAborts.delete(frame.request_id);
          }
          return;
        }

        if (frame.type === 'keep_alive' || frame.type === 'transcript_mirror') {
          return;
        }

        if (frame.type === 'result') {
          resultReceived = true;
          queue.push(frame);
          maybeFinishStdinAfterResult();
          return;
        }

        queue.push(frame);
      });

      child.on('error', (err) => {
        for (const [, waiter] of pendingControlResponses) waiter.reject(err);
        pendingControlResponses.clear();
        queue.fail(err);
      });

      const abortSignal = options.abortController?.signal;
      const onAbort = () => close();

      function cleanupAbortListener() {
        abortSignal?.removeEventListener('abort', onAbort);
      }

      child.on('close', (code) => {
        cleanupAbortListener();
        rl.close();
        for (const [, ctrl] of inFlightControlAborts) ctrl.abort();
        inFlightControlAborts.clear();
        for (const [, waiter] of pendingControlResponses) {
          waiter.reject(new Error(`Claude CLI exited with code ${code ?? 'unknown'}`));
        }
        pendingControlResponses.clear();

        if (!closed && !resultReceived && code !== 0 && code !== null) {
          const detail = stderrTail.trim();
          queue.fail(
            new Error(
              detail
                ? `Claude CLI exited with code ${code}: ${detail}`
                : `Claude CLI exited with code ${code}`
            )
          );
          return;
        }
        queue.end();
      });

      // Kick off control-channel initialization (non-fatal if older CLI ignores it).
      const initPromise = sendControlRequest({ subtype: 'initialize' }, 3000).catch(() => null);

      function formatOutgoingUserMessage(item) {
        if (typeof item === 'string') {
          return {
            type: 'user',
            session_id: latestSessionId,
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: item }] },
          };
        }
        return {
          type: 'user',
          session_id: item?.session_id ?? latestSessionId,
          parent_tool_use_id: item?.parent_tool_use_id ?? null,
          ...item,
        };
      }

      if (isSingleStringPrompt) {
        writeLine(formatOutgoingUserMessage(prompt));
        promptPumpFinished = true;
      } else if (prompt && typeof prompt[Symbol.asyncIterator] === 'function') {
        (async () => {
          try {
            for await (const msg of prompt) {
              if (closed) break;
              writeLine(formatOutgoingUserMessage(msg));
            }
          } catch {
            // Stream closed or aborted.
          } finally {
            promptPumpFinished = true;
            maybeFinishStdinAfterResult();
          }
        })();
      } else {
        promptPumpFinished = true;
      }

      function terminateChild() {
        if (child.killed || child.exitCode !== null) return;
        try {
          if (!IS_WINDOWS) child.kill('SIGINT');
          else child.kill();
        } catch {
          // Ignore kill races.
        }
      }

      async function interrupt() {
        closed = true;
        cleanupAbortListener();
        try {
          await sendControlRequest({ subtype: 'interrupt' }, 600);
        } catch {
          // Fall back to process signal termination.
        }
        endStdin();
        terminateChild();
        queue.end();
      }

      function close() {
        if (closed) return;
        closed = true;
        cleanupAbortListener();
        for (const [, ctrl] of inFlightControlAborts) ctrl.abort();
        inFlightControlAborts.clear();
        endStdin();
        terminateChild();
        queue.end();
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          close();
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const generator = (async function* () {
        while (true) {
          const step = await queue.next();
          if (step.done) return;
          yield step.value;
        }
      })();

      generator.interrupt = interrupt;
      generator.close = close;
      generator.steer = async (userMessage) => {
        if (!writeLine(formatOutgoingUserMessage(userMessage))) {
          throw new Error('Claude CLI stdin is closed; cannot steer active turn');
        }
      };
      generator.streamInput = async (iterable) => {
        for await (const item of iterable) {
          if (!writeLine(formatOutgoingUserMessage(item))) break;
        }
      };
      generator.setPermissionMode = async (mode) => {
        await sendControlRequest({ subtype: 'set_permission_mode', mode }, 2000);
      };
      generator.setModel = async (model) => {
        await sendControlRequest({ subtype: 'set_model', model }, 2000);
      };
      generator.supportedModels = async () => {
        const res = await initPromise;
        return Array.isArray(res?.models) ? res.models : [];
      };
      generator.supportedCommands = async () => {
        const res = await initPromise;
        return Array.isArray(res?.commands) ? res.commands : [];
      };

      return generator;
    },
  };
}
