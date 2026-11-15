#!/usr/bin/env node

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  buildClaudeCliArgs,
  createClaudeCliSdkFallback,
  isWindowsBatchScript,
  resolveClaudeCliExecutable,
  spawnClaudeProcess,
  unwrapClaudeCliExecutable,
} from './claude-native-cli.mjs';
import {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  PromptCacheTtlTracker,
  buildSdkContentBlocks,
  extractMessageUsage,
  extractNormalizedUsage,
  extractRateLimitInfo,
  isOfficialAnthropicSession,
  isPlaceholderSessionId,
  normalizeSdkEvent,
  readBoolean,
  readFiniteNumber,
  readString,
} from './claude-native-events.mjs';

export {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  PromptCacheTtlTracker,
  buildClaudeCliArgs,
  buildSdkContentBlocks,
  createClaudeCliSdkFallback,
  extractNormalizedUsage,
  extractRateLimitInfo,
  isOfficialAnthropicSession,
  isPlaceholderSessionId,
  normalizeSdkEvent,
  resolveClaudeCliExecutable,
  unwrapClaudeCliExecutable,
};

export const PROBE_OK = 'claude-native-driver:ok';

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_ENGINE_ERROR = -32000;

const VALID_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

function toPermissionMode(value) {
  return VALID_PERMISSION_MODES.has(value) ? value : undefined;
}

function toEffort(value) {
  if (value === 'extra_high') return 'xhigh';
  return VALID_EFFORTS.has(value) ? value : undefined;
}

function applyClaudeExecutableToSdkOptions(options, rawExecutable, env, { isCliFallback = false } = {}) {
  const cleaned = readString(rawExecutable);
  if (!cleaned) return;
  const resolved =
    unwrapClaudeCliExecutable(cleaned) ??
    resolveClaudeCliExecutable({
      env,
      options: { pathToClaudeCodeExecutable: cleaned },
    }) ??
    cleaned;
  options.pathToClaudeCodeExecutable = resolved;
  const lower = resolved.toLowerCase();
  if (
    !isCliFallback &&
    ((process.platform === 'win32' && isWindowsBatchScript(resolved)) || lower.endsWith('.cjs'))
  ) {
    options.spawnClaudeCodeProcess = (spawnSpec) => spawnClaudeProcess(spawnSpec);
  }
}

export async function resolveClaudeAgentSdk({ env = process.env, cwd } = {}) {
  if (readString(env?.VIBEX_FORCE_CLAUDE_CLI_FALLBACK) === '1') {
    return createClaudeCliSdkFallback({ env });
  }

  const candidates = [];
  const explicitSdkPath = readString(env?.VIBEX_CLAUDE_SDK_PATH);
  if (explicitSdkPath) candidates.push(explicitSdkPath);

  const managedAgentDir = readString(env?.VIBEX_CLAUDE_AGENT_DIR);
  if (managedAgentDir) {
    candidates.push(
      path.join(managedAgentDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    );
  }

  const home = readString(env?.USERPROFILE ?? env?.HOME) ?? os.homedir();
  const appData = readString(env?.APPDATA) ?? (home ? path.join(home, 'AppData', 'Roaming') : null);
  if (appData) {
    const npmModules = path.join(appData, 'npm', 'node_modules');
    candidates.push(path.join(npmModules, '@anthropic-ai', 'claude-agent-sdk'));
    candidates.push(
      path.join(
        npmModules,
        '@agentclientprotocol',
        'claude-agent-acp',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk'
      )
    );
  }
  if (home) {
    const localModules = path.join(home, '.local', 'lib', 'node_modules');
    candidates.push(path.join(localModules, '@anthropic-ai', 'claude-agent-sdk'));
    candidates.push(
      path.join(
        localModules,
        '@agentclientprotocol',
        'claude-agent-acp',
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk'
      )
    );
  }

  const req = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('file://')) return await import(candidate);
      return await import(pathToFileURL(req.resolve(candidate)).href);
    } catch {
      try {
        return await import(pathToFileURL(path.resolve(candidate)).href);
      } catch {
        // Continue to next resolution candidate.
      }
    }
  }

  if (cwd) {
    try {
      const cwdReq = createRequire(path.join(cwd, 'package.json'));
      const resolved = cwdReq.resolve('@anthropic-ai/claude-agent-sdk');
      return await import(pathToFileURL(resolved).href);
    } catch {
      // Fall through to standard import or CLI fallback.
    }
  }

  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return createClaudeCliSdkFallback({ env });
  }
}

class LivePromptStream {
  constructor(initialMessage) {
    this.queue = initialMessage ? [initialMessage] : [];
    this.waiters = [];
    this.closed = false;
  }

  push(message) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.queue.push(message);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function buildUserMessage(params) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: buildSdkContentBlocks(params) },
  };
}

function detectSlashCommand(params) {
  if (Array.isArray(params.images) && params.images.length > 0) return undefined;
  if (Array.isArray(params.blocks) && params.blocks.some((b) => b?.type === 'image')) {
    return undefined;
  }
  const text =
    typeof params.text === 'string'
      ? params.text
      : Array.isArray(params.blocks) &&
          params.blocks.length === 1 &&
          params.blocks[0]?.type === 'text'
        ? String(params.blocks[0].text ?? '')
        : '';
  return /^\s*\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?\s*$/.test(text) ? text.trim() : undefined;
}

function extractMessageModel(message) {
  if (!message || typeof message !== 'object') return undefined;
  const direct = readString(
    message.served_model ??
      message.servedModel ??
      message.model ??
      message.message?.model ??
      (message.type === 'stream_event'
        ? message.event?.message?.model ?? message.event?.model
        : undefined)
  );
  if (direct) return direct;
  if (message.modelUsage && typeof message.modelUsage === 'object') {
    for (const key of Object.keys(message.modelUsage)) {
      const cleaned = readString(key);
      if (cleaned) return cleaned;
    }
  }
  return undefined;
}

export class ClaudeNativeSidecarServer {
  constructor({ sendMessage, env = process.env, sdkLoader = resolveClaudeAgentSdk, now = Date.now }) {
    this.sendMessage = sendMessage;
    this.baseEnv = { ...env };
    this.sdkLoader = sdkLoader;
    this.now = now;
    this.sdkPromise = null;
    this.config = {
      workspaceId: null,
      workingDir: process.cwd(),
      model: undefined,
      effort: undefined,
      permissionMode: undefined,
      auth: {},
      env: {},
      configOverrides: {},
      mcpServers: {},
      additionalDirectories: [],
      cacheTtl: '5m',
    };
    this.officialSession = isOfficialAnthropicSession({ env: this.baseEnv });
    this.cacheTracker = new PromptCacheTtlTracker({
      officialSession: this.officialSession,
      now: this.now,
    });
    this.latestRateLimits = null;
    this.activeTurn = null;
    this.pendingPermissions = new Map();
    this.pendingQuestions = new Map();
    this.pendingSessionState = new Map();
    this.establishedSessions = new Set();
    this.permissionSeq = 0;
    this.questionSeq = 0;
  }

  emitEvent(event) {
    this.sendMessage({ jsonrpc: '2.0', method: 'engine/event', params: event });
  }

  respondResult(id, result) {
    if (id !== undefined) this.sendMessage({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message, data) {
    if (id === undefined) return;
    const error = { code, message, ...(data !== undefined ? { data } : {}) };
    this.sendMessage({ jsonrpc: '2.0', id, error });
  }

  async getSdk() {
    if (!this.sdkPromise) {
      this.sdkPromise = Promise.resolve(
        this.sdkLoader({
          env: { ...this.baseEnv, ...this.config.env },
          cwd: this.config.workingDir,
        })
      ).catch((err) => {
        this.sdkPromise = null;
        throw err;
      });
    }
    return this.sdkPromise;
  }

  effectiveEnv() {
    const merged = {
      ...this.baseEnv,
      ...this.config.env,
      CLAUDE_AGENT_SDK_CLIENT_APP:
        this.config.env.CLAUDE_AGENT_SDK_CLIENT_APP ??
        this.baseEnv.CLAUDE_AGENT_SDK_CLIENT_APP ??
        'vibex/claude-native-driver',
    };
    const apiKey = readString(this.config.auth?.apiKey);
    const oauthToken = readString(this.config.auth?.oauthToken);
    if (apiKey) merged.ANTHROPIC_API_KEY = apiKey;
    if (oauthToken) merged.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    return merged;
  }

  createHookCallbacks(promptId, getSessionId) {
    const makeHook = (hookName) => async (input, toolUseId) => {
      this.emitEvent({
        kind: 'hook_event',
        sessionId: getSessionId(),
        promptId,
        hookName,
        toolUseId: readString(toolUseId) ?? null,
        payload: input ?? {},
      });
      return { continue: true };
    };
    return {
      SubagentStop: [{ hooks: [makeHook('SubagentStop')] }],
      Notification: [{ hooks: [makeHook('Notification')] }],
    };
  }

  createCanUseToolCallback(promptId, getSessionId) {
    return async (toolName, input, toolOptions = {}) => {
      const sessionId = getSessionId();
      const abortSignal = toolOptions?.signal;

      if (toolName === 'AskUserQuestion') {
        const requestId =
          readString(toolOptions?.toolUseID ?? toolOptions?.requestId) ??
          `question-${++this.questionSeq}`;
        const toolCallId = readString(toolOptions?.toolUseID) ?? null;

        return new Promise((resolve) => {
          const onAbort = () => {
            if (!this.pendingQuestions.has(requestId)) return;
            this.pendingQuestions.delete(requestId);
            resolve({ behavior: 'deny', message: 'User question aborted' });
          };

          if (abortSignal && typeof abortSignal.addEventListener === 'function') {
            if (abortSignal.aborted) {
              resolve({ behavior: 'deny', message: 'User question aborted' });
              return;
            }
            abortSignal.addEventListener('abort', onAbort, { once: true });
          }

          this.pendingQuestions.set(requestId, {
            requestId,
            promptId,
            sessionId,
            input: input && typeof input === 'object' ? input : {},
            resolve: (result) => {
              if (abortSignal && typeof abortSignal.removeEventListener === 'function') {
                abortSignal.removeEventListener('abort', onAbort);
              }
              resolve(result);
            },
          });

          this.emitEvent({
            kind: 'question_requested',
            requestId,
            promptId,
            sessionId,
            toolCallId,
            questions: Array.isArray(input?.questions) ? input.questions : [],
          });
        });
      }

      const permissionId =
        readString(toolOptions?.toolUseID ?? toolOptions?.permissionId) ??
        `perm-${++this.permissionSeq}`;

      return new Promise((resolve) => {
        const onAbort = () => {
          if (!this.pendingPermissions.has(permissionId)) return;
          this.pendingPermissions.delete(permissionId);
          resolve({ behavior: 'deny', message: 'Tool permission request aborted' });
        };

        if (abortSignal && typeof abortSignal.addEventListener === 'function') {
          if (abortSignal.aborted) {
            resolve({ behavior: 'deny', message: 'Tool permission request aborted' });
            return;
          }
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        const suggestions = Array.isArray(toolOptions?.suggestions)
          ? toolOptions.suggestions
          : null;

        this.pendingPermissions.set(permissionId, {
          permissionId,
          promptId,
          sessionId,
          toolName,
          input,
          suggestions,
          resolve: (decisionResult) => {
            if (abortSignal && typeof abortSignal.removeEventListener === 'function') {
              abortSignal.removeEventListener('abort', onAbort);
            }
            resolve(decisionResult);
          },
        });

        this.emitEvent({
          kind: 'permission_requested',
          permissionId,
          promptId,
          sessionId,
          toolName,
          input: input ?? {},
          suggestions,
          blockedPath: readString(toolOptions?.blockedPath) ?? null,
          decisionReason: readString(toolOptions?.decisionReason) ?? null,
        });
      });
    };
  }

  buildQueryOptions(params, promptId, abortController, getSessionId, { isCliFallback = false } = {}) {
    const rawParamSessionId = readString(params.sessionId);
    const rawParamResume = typeof params.resume === 'string' ? readString(params.resume) : undefined;
    const cleanSessionId =
      rawParamSessionId && !isPlaceholderSessionId(rawParamSessionId)
        ? rawParamSessionId
        : undefined;
    const cleanResume =
      rawParamResume && !isPlaceholderSessionId(rawParamResume) ? rawParamResume : undefined;

    const targetSessionKey = cleanSessionId ?? cleanResume ?? 'default';
    const staged = this.pendingSessionState.get(targetSessionKey);
    if (staged) this.pendingSessionState.delete(targetSessionKey);

    const env = this.effectiveEnv();
    const options = {
      cwd: readString(params.cwd ?? params.workingDir) ?? this.config.workingDir,
      env,
      abortController,
      enableFileCheckpointing: true,
      includePartialMessages: true,
      includeHookEvents: true,
      canUseTool: this.createCanUseToolCallback(promptId, getSessionId),
      hooks: this.createHookCallbacks(promptId, getSessionId),
    };

    const explicitClaudeExecutable = readString(
      params.pathToClaudeCodeExecutable ?? env.CLAUDE_CODE_EXECUTABLE ?? env.VIBEX_CLAUDE_PATH
    );
    if (explicitClaudeExecutable) {
      applyClaudeExecutableToSdkOptions(options, explicitClaudeExecutable, env, { isCliFallback });
    }

    const model = readString(params.model) ?? this.config.model;
    if (model) options.model = model;

    const effort = toEffort(readString(params.effort) ?? this.config.effort);
    if (effort) options.effort = effort;

    const permissionMode = toPermissionMode(
      readString(params.permissionMode) ?? this.config.permissionMode
    );
    if (permissionMode) {
      options.permissionMode = permissionMode;
      if (permissionMode === 'bypassPermissions') {
        options.allowDangerouslySkipPermissions = true;
      }
    }

    const mcpServers =
      params.mcpServers && typeof params.mcpServers === 'object' && !Array.isArray(params.mcpServers)
        ? params.mcpServers
        : this.config.mcpServers;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    const additionalDirsSource = Array.isArray(params.additionalDirectories)
      ? params.additionalDirectories
      : this.config.additionalDirectories;
    if (Array.isArray(additionalDirsSource) && additionalDirsSource.length > 0) {
      const cleanedDirs = additionalDirsSource.map(readString).filter(Boolean);
      if (cleanedDirs.length > 0) options.additionalDirectories = cleanedDirs;
    }

    const forkSession = readBoolean(params.forkSession) ?? staged?.forkSession;
    const stagedResume =
      staged?.resume && !isPlaceholderSessionId(staged.resume) ? staged.resume : undefined;
    const stagedSessionId =
      staged?.sessionId && !isPlaceholderSessionId(staged.sessionId)
        ? staged.sessionId
        : undefined;

    let resume;
    if (cleanResume) {
      resume = cleanResume;
    } else if (stagedResume) {
      resume = stagedResume;
    } else if (!forkSession && cleanSessionId) {
      if (params.resume === true || this.establishedSessions.has(cleanSessionId)) {
        resume = cleanSessionId;
      }
    }

    const sessionId = stagedSessionId ?? (forkSession ? cleanSessionId : undefined);
    const resumeSessionAt =
      readString(params.resumeSessionAt) ?? staged?.resumeSessionAt;

    if (resume) options.resume = resume;
    if (forkSession !== undefined) options.forkSession = forkSession;
    if (sessionId && (!resume || forkSession)) options.sessionId = sessionId;
    if (resumeSessionAt) options.resumeSessionAt = resumeSessionAt;

    const maxTurns = readFiniteNumber(params.maxTurns);
    if (maxTurns !== undefined && maxTurns > 0) options.maxTurns = maxTurns;

    return options;
  }

  async handleInitialize(params = {}) {
    const envEntries =
      params.env && typeof params.env === 'object' && !Array.isArray(params.env)
        ? Object.fromEntries(
            Object.entries(params.env).filter(([, val]) => typeof val === 'string')
          )
        : {};

    this.sdkPromise = null;
    this.config = {
      workspaceId: readString(params.workspaceId) ?? null,
      workingDir: readString(params.workingDir ?? params.cwd) ?? this.config.workingDir,
      model: readString(params.model),
      effort: readString(params.effort),
      permissionMode: readString(params.permissionMode),
      auth: params.auth && typeof params.auth === 'object' ? params.auth : {},
      env: envEntries,
      configOverrides:
        params.configOverrides && typeof params.configOverrides === 'object'
          ? params.configOverrides
          : {},
      mcpServers:
        params.mcpServers &&
        typeof params.mcpServers === 'object' &&
        !Array.isArray(params.mcpServers)
          ? params.mcpServers
          : {},
      additionalDirectories: Array.isArray(params.additionalDirectories)
        ? params.additionalDirectories.map(readString).filter(Boolean)
        : [],
      cacheTtl: params.cacheTtl === '1h' ? '1h' : '5m',
    };

    this.officialSession = isOfficialAnthropicSession({
      env: { ...this.baseEnv, ...this.config.env },
      auth: this.config.auth,
      configOverrides: this.config.configOverrides,
    });
    this.cacheTracker.defaultTier = this.config.cacheTtl;
    this.cacheTracker.setOfficialSession(this.officialSession);

    const sdk = await this.getSdk();
    if (typeof sdk?.query !== 'function') {
      throw new Error('Resolved Claude runtime does not export query()');
    }

    let models = [];
    if (typeof sdk.supportedModels === 'function') {
      try {
        const supported = await sdk.supportedModels();
        if (Array.isArray(supported)) models = supported;
      } catch {
        // Optional probe on SDK; fallback catalog used on host if unavailable.
      }
    }

    return {
      protocolVersion: '1.0',
      engineId: 'claude-native',
      officialAnthropicSession: this.officialSession,
      transport: sdk.isCliFallback ? 'cli-fallback' : 'agent-sdk',
      models,
      capabilities: {
        steering: true,
        forkSession: true,
        revertSession: true,
        permissions: true,
        questions: true,
        rateLimits: true,
        promptCacheTtl: this.officialSession,
        subagents: true,
        hooks: true,
      },
    };
  }

  async handlePromptSend(params = {}) {
    const promptId = readString(params.promptId);
    if (!promptId) throw rpcError(JSONRPC_INVALID_PARAMS, 'Missing required parameter: promptId');
    if (this.activeTurn) {
      throw rpcError(JSONRPC_ENGINE_ERROR, `Turn ${this.activeTurn.promptId} is already running`);
    }

    const sdk = await this.getSdk();
    if (typeof sdk?.query !== 'function') {
      throw new Error('Resolved Claude Agent SDK does not export query()');
    }

    const rawCandidateSid = readString(
      typeof params.resume === 'string' ? params.resume : params.sessionId
    );
    let currentSessionId =
      rawCandidateSid && !isPlaceholderSessionId(rawCandidateSid) ? rawCandidateSid : null;

    const abortController = new AbortController();
    const slashCommand = detectSlashCommand(params);
    const liveStream = slashCommand ? null : new LivePromptStream(buildUserMessage(params));
    const options = this.buildQueryOptions(
      params,
      promptId,
      abortController,
      () => currentSessionId,
      { isCliFallback: Boolean(sdk.isCliFallback) }
    );

    const requestSentAtMs = this.cacheTracker.markRequestSent(this.now());
    const requestedCacheTtl =
      params.cacheTtl === '1h' ? '1h' : params.cacheTtl === '5m' ? '5m' : this.config.cacheTtl;

    let queryHandle;
    try {
      queryHandle = sdk.query({ prompt: slashCommand ?? liveStream, options });
    } catch (error) {
      if (
        !options.pathToClaudeCodeExecutable &&
        error instanceof Error &&
        /Native CLI binary .* not found/i.test(error.message)
      ) {
        const fallbackExe = resolveClaudeCliExecutable({ env: options.env, options });
        if (!fallbackExe) throw error;
        applyClaudeExecutableToSdkOptions(options, fallbackExe, options.env, {
          isCliFallback: Boolean(sdk.isCliFallback),
        });
        queryHandle = sdk.query({ prompt: slashCommand ?? liveStream, options });
      } else {
        throw error;
      }
    }
    const subagentRegistry = new Map();

    const turnState = {
      promptId,
      get sessionId() {
        return currentSessionId;
      },
      abortController,
      liveStream,
      queryHandle,
      interrupted: false,
      requestSentAtMs,
      requestedCacheTtl,
      completionPromise: null,
    };
    this.activeTurn = turnState;
    this.emitEvent({ kind: 'turn_started', promptId, sessionId: currentSessionId });

    turnState.completionPromise = (async () => {
      let servedModel = null;
      let terminalEvent = null;
      try {
        for await (const message of queryHandle) {
          const msgSessionId = readString(message?.session_id ?? message?.sessionId);
          if (msgSessionId && !isPlaceholderSessionId(msgSessionId)) {
            currentSessionId = msgSessionId;
            this.establishedSessions.add(msgSessionId);
          }

          const observedModel = extractMessageModel(message);
          if (observedModel) servedModel = observedModel;

          const usage = extractMessageUsage(message);
          if (usage) {
            const cacheStatus = this.cacheTracker.observeUsage(usage, {
              requestSentAtMs: turnState.requestSentAtMs,
              cacheTtl: turnState.requestedCacheTtl,
            });
            if (cacheStatus) {
              this.emitEvent({
                kind: 'cache_status_updated',
                sessionId: currentSessionId,
                promptId,
                cacheStatus,
              });
            }
          }

          const normalized = normalizeSdkEvent(message, {
            promptId,
            fallbackSessionId: currentSessionId,
            fallbackModel: servedModel ?? options.model ?? null,
            subagentRegistry,
          });
          for (const event of normalized) {
            if (event.kind === 'rate_limits_updated') this.latestRateLimits = event.rateLimits;
            if (event.kind === 'turn_completed') {
              const resolvedServedModel =
                readString(event.served_model ?? event.servedModel) ?? servedModel ?? null;
              terminalEvent = { ...event, served_model: resolvedServedModel };
            } else {
              this.emitEvent(event);
            }
          }

          if (message?.type === 'result') liveStream?.close();
        }
      } catch (error) {
        if (!turnState.interrupted) {
          terminalEvent = {
            kind: 'turn_error',
            sessionId: currentSessionId,
            promptId,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        liveStream?.close();
        if (this.activeTurn === turnState) this.activeTurn = null;
        if (terminalEvent) this.emitEvent(terminalEvent);
      }
    })();

    if (params.waitForCompletion === true) {
      await turnState.completionPromise;
    }

    return { accepted: true, promptId, sessionId: currentSessionId };
  }

  async handlePromptSteer(params = {}) {
    const turn = this.activeTurn;
    const expectedPromptId = readString(params.expectedPromptId ?? params.promptId);
    if (!turn || (expectedPromptId && turn.promptId !== expectedPromptId)) {
      return {
        status: 'rejected',
        code: 'no_running_turn',
        message: 'No matching in-flight turn is active',
      };
    }

    const userMessage = buildUserMessage(params);
    turn.requestSentAtMs = this.cacheTracker.markRequestSent(this.now());

    if (typeof turn.queryHandle?.steer === 'function') {
      await turn.queryHandle.steer(userMessage);
    } else if (turn.liveStream && turn.liveStream.push(userMessage)) {
      // Pushed directly into open AsyncIterable prompt stream.
    } else if (typeof turn.queryHandle?.streamInput === 'function') {
      await turn.queryHandle.streamInput(
        (async function* () {
          yield userMessage;
        })()
      );
    } else {
      return {
        status: 'rejected',
        code: 'steering_unavailable',
        message: 'Active turn was started with a non-streamable slash command',
      };
    }

    this.emitEvent({ kind: 'prompt_steered', promptId: turn.promptId, sessionId: turn.sessionId });
    return {
      status: 'accepted',
      deliveryMode: 'native',
      promptId: turn.promptId,
      sessionId: turn.sessionId,
    };
  }

  async handlePromptInterrupt(params = {}) {
    const turn = this.activeTurn;
    if (!turn) return { interrupted: false, reason: 'no_running_turn' };

    turn.interrupted = true;
    turn.liveStream?.close();
    turn.abortController.abort();

    for (const [permissionId, pending] of this.pendingPermissions.entries()) {
      if (pending.promptId === turn.promptId) {
        this.pendingPermissions.delete(permissionId);
        pending.resolve({ behavior: 'deny', message: 'Turn interrupted', interrupt: true });
      }
    }
    for (const [requestId, pending] of this.pendingQuestions.entries()) {
      if (pending.promptId === turn.promptId) {
        this.pendingQuestions.delete(requestId);
        pending.resolve({ behavior: 'deny', message: 'Turn interrupted', interrupt: true });
      }
    }

    try {
      if (typeof turn.queryHandle?.interrupt === 'function') {
        await turn.queryHandle.interrupt();
      } else if (typeof turn.queryHandle?.close === 'function') {
        turn.queryHandle.close();
      }
    } catch {
      // Aborting turn.abortController immediately closes @anthropic-ai/claude-agent-sdk's
      // ProcessTransport, which causes queryHandle.interrupt() to reject with "Operation aborted".
    }

    this.emitEvent({
      kind: 'turn_interrupted',
      promptId: turn.promptId,
      sessionId: turn.sessionId,
      reason: readString(params.reason) ?? 'user_interrupted',
    });

    await turn.completionPromise?.catch(() => undefined);
    return { interrupted: true, promptId: turn.promptId, sessionId: turn.sessionId };
  }

  async handleSessionFork(params = {}) {
    const sourceSessionId = readString(params.sessionId ?? params.sourceSessionId);
    if (!sourceSessionId || isPlaceholderSessionId(sourceSessionId)) {
      throw rpcError(JSONRPC_INVALID_PARAMS, 'Missing required parameter: sessionId');
    }

    const hasExplicitCheckpoint =
      ('resumeSessionAt' in params &&
        params.resumeSessionAt !== null &&
        params.resumeSessionAt !== undefined) ||
      ('checkpointId' in params &&
        params.checkpointId !== null &&
        params.checkpointId !== undefined);
    const resumeSessionAt = readString(params.resumeSessionAt ?? params.checkpointId);
    if (hasExplicitCheckpoint && !resumeSessionAt) {
      throw rpcError(
        JSONRPC_INVALID_PARAMS,
        'Invalid empty checkpoint anchor for session/fork'
      );
    }

    const targetSessionId =
      readString(params.newSessionId) ?? `${sourceSessionId}-fork-${Date.now()}`;

    this.pendingSessionState.set(targetSessionId, {
      forkSession: true,
      resume: sourceSessionId,
      sessionId: targetSessionId,
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
    });

    const sdk = await this.getSdk().catch(() => null);
    if (typeof sdk?.forkSession === 'function') {
      await sdk.forkSession({
        sessionId: sourceSessionId,
        newSessionId: targetSessionId,
        resumeSessionAt: resumeSessionAt ?? undefined,
      });
    }

    this.emitEvent({
      kind: 'session_forked',
      sourceSessionId,
      sessionId: targetSessionId,
      resumeSessionAt: resumeSessionAt ?? null,
    });
    return {
      forked: true,
      sourceSessionId,
      sessionId: targetSessionId,
      resumeSessionAt: resumeSessionAt ?? null,
    };
  }

  async handleSessionRevert(params = {}) {
    const sessionId = readString(params.sessionId);
    const resumeSessionAt = readString(
      params.resumeSessionAt ?? params.checkpointId ?? params.messageUuid
    );
    if (!sessionId || isPlaceholderSessionId(sessionId) || !resumeSessionAt) {
      throw rpcError(
        JSONRPC_INVALID_PARAMS,
        'Missing required parameters: sessionId and resumeSessionAt'
      );
    }

    if (this.activeTurn && this.activeTurn.sessionId === sessionId) {
      await this.handlePromptInterrupt({ reason: 'session_revert' });
    }

    const existing = this.pendingSessionState.get(sessionId) ?? {};
    this.pendingSessionState.set(sessionId, {
      ...existing,
      resume: existing.resume ?? sessionId,
      resumeSessionAt,
    });

    const sdk = await this.getSdk().catch(() => null);
    if (typeof sdk?.revertSession === 'function') {
      await sdk.revertSession({ sessionId, resumeSessionAt });
    }

    this.emitEvent({ kind: 'session_reverted', sessionId, resumeSessionAt });
    return { reverted: true, sessionId, resumeSessionAt };
  }

  async handlePermissionRespond(params = {}) {
    const permissionId = readString(params.permissionId);
    if (!permissionId) {
      throw rpcError(JSONRPC_INVALID_PARAMS, 'Missing required parameter: permissionId');
    }

    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return { resolved: false, permissionId, code: 'unknown_permission' };

    this.pendingPermissions.delete(permissionId);
    const decision = readString(params.behavior ?? params.decision ?? params.optionId);
    const allowed =
      params.approved === true ||
      decision === 'allow' ||
      decision === 'allow_once' ||
      decision === 'allow_always' ||
      decision === 'accept' ||
      decision === 'acceptForSession';
    const persistSessionRule = decision === 'allow_always' || decision === 'acceptForSession';

    if (allowed) {
      pending.resolve({
        behavior: 'allow',
        updatedInput:
          params.updatedInput && typeof params.updatedInput === 'object'
            ? params.updatedInput
            : pending.input,
        ...(persistSessionRule &&
        Array.isArray(pending.suggestions) &&
        pending.suggestions.length > 0
          ? { updatedPermissions: pending.suggestions }
          : {}),
      });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: readString(params.message) ?? 'Permission denied by user',
        ...(params.interrupt === true ? { interrupt: true } : {}),
      });
    }

    const behavior = allowed ? 'allow' : 'deny';
    this.emitEvent({
      kind: 'permission_resolved',
      permissionId,
      promptId: pending.promptId,
      sessionId: pending.sessionId,
      behavior,
    });
    return { resolved: true, permissionId, behavior };
  }

  async handleQuestionRespond(params = {}) {
    const requestId = readString(params.requestId ?? params.questionId);
    if (!requestId) {
      throw rpcError(JSONRPC_INVALID_PARAMS, 'Missing required parameter: requestId');
    }

    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return { resolved: false, requestId, code: 'unknown_question' };

    this.pendingQuestions.delete(requestId);
    if (params.cancelled === true) {
      pending.resolve({
        behavior: 'deny',
        message: readString(params.message) ?? 'User cancelled question',
      });
      return { resolved: true, requestId, cancelled: true };
    }

    const answers =
      params.answers && typeof params.answers === 'object' && !Array.isArray(params.answers)
        ? params.answers
        : {};
    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        answers,
      },
    });
    return { resolved: true, requestId, cancelled: false };
  }

  async handleStatusGet() {
    return {
      officialAnthropicSession: this.officialSession,
      cacheStatus: this.cacheTracker.getPublicStatus('status', this.now()),
      rateLimits: this.latestRateLimits,
    };
  }

  async handleShutdown() {
    if (this.activeTurn) {
      await this.handlePromptInterrupt({ reason: 'shutdown' });
    }
    for (const [permissionId, pending] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(permissionId);
      pending.resolve({ behavior: 'deny', message: 'Driver shutting down', interrupt: true });
    }
    for (const [requestId, pending] of this.pendingQuestions.entries()) {
      this.pendingQuestions.delete(requestId);
      pending.resolve({ behavior: 'deny', message: 'Driver shutting down', interrupt: true });
    }
    return { ok: true };
  }

  async handleRpcMessage(rawLine) {
    const trimmed = typeof rawLine === 'string' ? rawLine.trim() : '';
    if (!trimmed) return null;

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      this.respondError(
        null,
        JSONRPC_PARSE_ERROR,
        error instanceof Error ? error.message : 'Invalid JSON'
      );
      return null;
    }

    if (!payload || typeof payload !== 'object' || payload.jsonrpc !== '2.0') {
      this.respondError(
        payload?.id ?? null,
        JSONRPC_INVALID_REQUEST,
        'Expected JSON-RPC 2.0 envelope'
      );
      return null;
    }

    const { id, method, params } = payload;
    if (typeof method !== 'string') {
      this.respondError(id ?? null, JSONRPC_INVALID_REQUEST, 'Missing JSON-RPC method');
      return null;
    }

    try {
      let result;
      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          break;
        case 'prompt/send':
          result = await this.handlePromptSend(params);
          break;
        case 'prompt/steer':
          result = await this.handlePromptSteer(params);
          break;
        case 'prompt/interrupt':
          result = await this.handlePromptInterrupt(params);
          break;
        case 'session/fork':
          result = await this.handleSessionFork(params);
          break;
        case 'session/revert':
          result = await this.handleSessionRevert(params);
          break;
        case 'permission/respond':
          result = await this.handlePermissionRespond(params);
          break;
        case 'question/respond':
          result = await this.handleQuestionRespond(params);
          break;
        case 'status/get':
          result = await this.handleStatusGet();
          break;
        case 'shutdown':
          result = await this.handleShutdown();
          break;
        default:
          this.respondError(id, JSONRPC_METHOD_NOT_FOUND, `Unsupported method: ${method}`);
          return null;
      }
      this.respondResult(id, result);
      return result;
    } catch (error) {
      this.respondError(
        id,
        error?.rpcCode ?? JSONRPC_ENGINE_ERROR,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }
}

const IN_TURN_CONCURRENT_METHODS = new Set([
  'prompt/steer',
  'prompt/interrupt',
  'permission/respond',
  'question/respond',
  'status/get',
]);

export function startClaudeNativeDriverStdioServer({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  sdkLoader = resolveClaudeAgentSdk,
  now = Date.now,
} = {}) {
  const server = new ClaudeNativeSidecarServer({
    env,
    sdkLoader,
    now,
    sendMessage: (frame) => stdout.write(`${JSON.stringify(frame)}\n`),
  });

  let rpcQueue = Promise.resolve();
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    let method = null;
    try {
      method = JSON.parse(line)?.method ?? null;
    } catch {
      // Let handleRpcMessage emit JSONRPC_PARSE_ERROR in order.
    }
    if (method && IN_TURN_CONCURRENT_METHODS.has(method) && server.activeTurn) {
      void server.handleRpcMessage(line);
      return;
    }
    rpcQueue = rpcQueue.then(() => server.handleRpcMessage(line)).catch(() => undefined);
  });

  rl.on('close', () => {
    rpcQueue = rpcQueue.then(() => server.handleShutdown()).catch(() => undefined);
  });

  return { server, readline: rl };
}

const isDirectEntry =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  if (process.argv.includes('--probe')) {
    process.stdout.write(`${PROBE_OK}\n`);
    process.exit(0);
  }
  startClaudeNativeDriverStdioServer();
}
