export const CACHE_TTL_5M_MS = 5 * 60 * 1000;
export const CACHE_TTL_1H_MS = 60 * 60 * 1000;

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent', 'dispatch_agent']);
const PLACEHOLDER_SESSION_PREFIXES = [
  'prepared-',
  'pending-',
  'dimo-new-session-',
  'claude-native-',
  'codex-native-',
];

export function readString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function isPlaceholderSessionId(value) {
  const cleaned = readString(value);
  if (!cleaned) return true;
  return PLACEHOLDER_SESSION_PREFIXES.some((prefix) => cleaned.startsWith(prefix));
}

export function readBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

export function readFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function toIsoTimestamp(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    const asNum = Number(value);
    return Number.isFinite(asNum) ? toIsoTimestamp(asNum) : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return undefined;
}

/**
 * Verifies the session targets official Anthropic infrastructure via the SDK
 * rather than a custom third-party proxy endpoint.
 */
export function isOfficialAnthropicSession({ env = {}, auth = {}, configOverrides = {} } = {}) {
  if (configOverrides?.isThirdPartyProxy === true || auth?.isThirdPartyProxy === true) {
    return false;
  }
  const rawBaseUrl =
    readString(configOverrides?.anthropicBaseUrl) ??
    readString(configOverrides?.baseUrl) ??
    readString(auth?.baseUrl) ??
    readString(env?.ANTHROPIC_BASE_URL);
  if (!rawBaseUrl) return true;
  try {
    const host = new URL(rawBaseUrl).hostname.toLowerCase();
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

/**
 * Synthesizes `promptCacheExpiresAt` from request dispatch time + TTL tier
 * (`5m` default vs `1h` extended) strictly for official Anthropic sessions,
 * omitting raw token counts per Anthropic SDK commercial terms.
 */
export class PromptCacheTtlTracker {
  constructor({ officialSession = true, defaultTier = '5m', now = Date.now } = {}) {
    this.officialSession = Boolean(officialSession);
    this.defaultTier = defaultTier === '1h' ? '1h' : '5m';
    this.now = now;
    this.lastRequestSentAtMs = null;
    this.expiresAtMs = null;
    this.activeTier = null;
  }

  setOfficialSession(isOfficial) {
    this.officialSession = Boolean(isOfficial);
    if (!this.officialSession) {
      this.expiresAtMs = null;
      this.activeTier = null;
    }
  }

  markRequestSent(sentAtMs = this.now()) {
    this.lastRequestSentAtMs = sentAtMs;
    return sentAtMs;
  }

  resolveTier(usage, requestedTier) {
    const explicitTier = requestedTier ?? this.defaultTier;
    const detail = usage?.cache_creation ?? usage?.cacheCreation;
    const ephemeral1h = readFiniteNumber(
      detail?.ephemeral_1h_input_tokens ?? detail?.ephemeral1hInputTokens
    );
    return (ephemeral1h !== undefined && ephemeral1h > 0) || explicitTier === '1h'
      ? '1h'
      : '5m';
  }

  observeUsage(usage, { requestSentAtMs, cacheTtl } = {}) {
    if (!this.officialSession || !usage || typeof usage !== 'object') return null;

    const createdTokens =
      readFiniteNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) ?? 0;
    const readTokens =
      readFiniteNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) ?? 0;

    const nowMs = this.now();
    if (createdTokens > 0) {
      const tier = this.resolveTier(usage, cacheTtl);
      const ttlMs = tier === '1h' ? CACHE_TTL_1H_MS : CACHE_TTL_5M_MS;
      const baseMs = requestSentAtMs ?? this.lastRequestSentAtMs ?? nowMs;
      this.expiresAtMs = baseMs + ttlMs;
      this.activeTier = tier;
      return this.getPublicStatus('created', nowMs);
    }

    if (readTokens > 0 && this.expiresAtMs !== null) {
      return this.getPublicStatus('hit', nowMs);
    }
    return null;
  }

  getPublicStatus(cacheEvent = 'status', nowMs = this.now()) {
    if (!this.officialSession || this.expiresAtMs === null) return null;
    return {
      promptCacheExpiresAt: new Date(this.expiresAtMs).toISOString(),
      promptCacheTtlRemainingMs: Math.max(0, this.expiresAtMs - nowMs),
      cacheTtlTier: this.activeTier ?? this.defaultTier,
      cacheEvent,
    };
  }
}

export function buildSdkContentBlocks(params = {}) {
  const content = [];
  if (Array.isArray(params.blocks) && params.blocks.length > 0) {
    for (const block of params.blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const data = readString(block.data) ?? readString(block.base64);
        const mediaType =
          readString(block.mimeType ?? block.mediaType ?? block.mime_type) ?? 'image/png';
        if (data) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
          });
        } else if (readString(block.uri)) {
          content.push({ type: 'text', text: `[image: ${block.uri.trim()}]` });
        }
      } else if (block.type === 'resource_link' && readString(block.uri)) {
        const label = readString(block.name) ?? block.uri;
        content.push({ type: 'text', text: `@${label} (${block.uri})` });
      }
    }
  } else {
    if (typeof params.text === 'string' && params.text.length > 0) {
      content.push({ type: 'text', text: params.text });
    }
    for (const image of params.images ?? []) {
      const data = readString(image?.base64 ?? image?.data);
      const mediaType = readString(image?.mediaType ?? image?.mimeType) ?? 'image/png';
      if (data) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
        });
      }
    }
  }
  return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

export function extractRateLimitInfo(message) {
  const raw =
    message?.rate_limit_info ??
    message?.rateLimitInfo ??
    message?.rateLimits ??
    (message?.type === 'rate_limit_event' ? message.rate_limit ?? message : null);
  if (!raw || typeof raw !== 'object') return null;

  const resetAt = toIsoTimestamp(raw.resetAt ?? raw.resetsAt ?? raw.reset_at ?? raw.resets_at);
  const requestsRemaining = readFiniteNumber(raw.requestsRemaining ?? raw.requests_remaining);
  const tokensRemaining = readFiniteNumber(raw.tokensRemaining ?? raw.tokens_remaining);
  const creditsRemaining = readFiniteNumber(raw.creditsRemaining ?? raw.credits_remaining);
  const utilization = readFiniteNumber(raw.utilization);
  const status = readString(raw.status);
  const rateLimitType = readString(raw.rateLimitType ?? raw.rate_limit_type);

  if (
    !resetAt &&
    requestsRemaining === undefined &&
    tokensRemaining === undefined &&
    creditsRemaining === undefined &&
    utilization === undefined &&
    !status
  ) {
    return null;
  }

  return {
    status: status ?? null,
    rateLimitType: rateLimitType ?? null,
    utilization: utilization ?? null,
    requestsRemaining: requestsRemaining ?? null,
    tokensRemaining: tokensRemaining ?? null,
    creditsRemaining: creditsRemaining ?? null,
    resetAt: resetAt ?? null,
  };
}

export function extractMessageUsage(message) {
  return (
    message?.usage ??
    message?.message?.usage ??
    (message?.type === 'stream_event'
      ? message.event?.usage ?? message.event?.message?.usage
      : undefined)
  );
}

export function extractNormalizedUsage(message, fallbackModel = null) {
  if (!message || typeof message !== 'object') return null;
  const rawUsage = extractMessageUsage(message);
  const inputTokens = readFiniteNumber(rawUsage?.input_tokens ?? rawUsage?.inputTokens);
  const outputTokens = readFiniteNumber(rawUsage?.output_tokens ?? rawUsage?.outputTokens);
  const cacheReadInputTokens = readFiniteNumber(
    rawUsage?.cache_read_input_tokens ?? rawUsage?.cacheReadInputTokens
  );
  const cacheCreationInputTokens = readFiniteNumber(
    rawUsage?.cache_creation_input_tokens ?? rawUsage?.cacheCreationInputTokens
  );
  const totalCostUsd = readFiniteNumber(message.total_cost_usd ?? message.totalCostUsd);

  let model =
    readString(
      message.served_model ??
        message.servedModel ??
        message.model ??
        message.message?.model ??
        (message.type === 'stream_event'
          ? message.event?.message?.model ?? message.event?.model
          : undefined)
    ) ?? fallbackModel;

  let contextWindow = readFiniteNumber(
    rawUsage?.context_window ?? rawUsage?.contextWindow ?? message.context_window
  );
  if (message.modelUsage && typeof message.modelUsage === 'object') {
    const keys = Object.keys(message.modelUsage);
    const chosenKey = (model && message.modelUsage[model] ? model : keys[0]) ?? null;
    if (chosenKey) {
      if (!model) model = readString(chosenKey) ?? null;
      const entry = message.modelUsage[chosenKey];
      if (contextWindow === undefined) {
        contextWindow = readFiniteNumber(entry?.contextWindow ?? entry?.context_window);
      }
    }
  }

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    totalCostUsd === undefined &&
    contextWindow === undefined
  ) {
    return null;
  }

  const isTurnSummary = message.type === 'result';
  const hasFullStepInput =
    inputTokens !== undefined ||
    cacheReadInputTokens !== undefined ||
    cacheCreationInputTokens !== undefined;
  const singleStepSum =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheReadInputTokens ?? 0) +
    (cacheCreationInputTokens ?? 0);
  const contextUsed =
    !isTurnSummary && hasFullStepInput && singleStepSum > 0 ? singleStepSum : null;

  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cacheReadInputTokens: cacheReadInputTokens ?? null,
    cacheCreationInputTokens: cacheCreationInputTokens ?? null,
    totalCostUsd: totalCostUsd ?? null,
    contextUsed,
    contextWindow: contextWindow ?? null,
    isTurnSummary,
    model: model ?? null,
  };
}

function extractTodoPlanEntries(input) {
  const todos = Array.isArray(input?.todos) ? input.todos : null;
  if (!todos) return null;
  return todos
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const content = readString(item.content ?? item.title ?? item.activeForm);
      if (!content) return null;
      return {
        content,
        status: readString(item.status) ?? 'pending',
        priority: readString(item.priority) ?? null,
      };
    })
    .filter(Boolean);
}

function extractTextFromBlocks(content) {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const joined = content
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('');
  return joined || undefined;
}

export function normalizeSdkEvent(
  message,
  {
    promptId = null,
    fallbackSessionId = null,
    fallbackModel = null,
    subagentRegistry = new Map(),
  } = {}
) {
  if (!message || typeof message !== 'object') return [];

  const events = [];
  const rawSessionId = readString(message.session_id) ?? readString(message.sessionId);
  const sessionId =
    (rawSessionId && !isPlaceholderSessionId(rawSessionId) ? rawSessionId : null) ??
    fallbackSessionId;
  const parentToolUseId =
    readString(message.parent_tool_use_id) ?? readString(message.parentToolUseId) ?? null;

  const rateLimits = extractRateLimitInfo(message);
  if (rateLimits) {
    events.push({ kind: 'rate_limits_updated', sessionId, promptId, rateLimits });
  }

  if (!parentToolUseId) {
    const usage = extractNormalizedUsage(message, fallbackModel);
    if (
      usage &&
      (usage.inputTokens !== null ||
        usage.outputTokens !== null ||
        usage.cacheReadInputTokens !== null ||
        usage.cacheCreationInputTokens !== null ||
        usage.totalCostUsd !== null ||
        usage.contextWindow !== null)
    ) {
      events.push({ kind: 'usage_updated', sessionId, promptId, usage });
    }
  }

  if (
    message.type === 'hook_event' ||
    (message.type === 'system' &&
      typeof message.subtype === 'string' &&
      message.subtype.startsWith('hook_'))
  ) {
    events.push({
      kind: 'hook_event',
      sessionId,
      promptId,
      hookName:
        readString(message.hook_name ?? message.hookName ?? message.subtype) ?? 'unknown',
      hookEvent: readString(message.hook_event ?? message.event) ?? null,
      payload: message,
    });
  }

  if (
    message.type === 'subagent_spawn' ||
    (message.type === 'system' && message.subtype === 'task_started')
  ) {
    const subagentId =
      readString(message.task_id ?? message.subagent_id ?? message.tool_use_id) ??
      parentToolUseId ??
      'subagent';
    const linkedToolUseId =
      parentToolUseId ??
      readString(message.tool_use_id ?? message.toolUseId) ??
      subagentRegistry.get(subagentId)?.parentToolUseId ??
      subagentId;
    subagentRegistry.set(subagentId, { spawned: true, parentToolUseId: linkedToolUseId });
    events.push({
      kind: 'subagent/spawn',
      sessionId,
      promptId,
      subagentId,
      parentToolUseId: linkedToolUseId,
      subagentType: readString(message.subagent_type ?? message.task_type) ?? null,
      description: readString(message.description) ?? null,
    });
  } else if (
    message.type === 'subagent_complete' ||
    (message.type === 'system' && message.subtype === 'task_notification')
  ) {
    const subagentId =
      readString(message.task_id ?? message.subagent_id ?? message.tool_use_id) ??
      parentToolUseId ??
      'subagent';
    const linkedToolUseId =
      parentToolUseId ??
      readString(message.tool_use_id ?? message.toolUseId) ??
      subagentRegistry.get(subagentId)?.parentToolUseId ??
      subagentId;
    subagentRegistry.delete(subagentId);
    if (linkedToolUseId !== subagentId) {
      subagentRegistry.delete(linkedToolUseId);
    }
    events.push({
      kind: 'subagent/complete',
      sessionId,
      promptId,
      subagentId,
      parentToolUseId: linkedToolUseId,
      status: readString(message.status) ?? 'completed',
      summary: readString(message.summary) ?? null,
    });
  }

  if (message.type === 'stream_event' && message.event) {
    const delta =
      message.event.type === 'content_block_delta' ? message.event.delta : undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      if (parentToolUseId) {
        events.push({
          kind: 'subagent/update',
          sessionId,
          promptId,
          subagentId: parentToolUseId,
          parentToolUseId,
          textDelta: delta.text,
        });
      } else {
        events.push({
          kind: 'assistant_text_delta',
          sessionId,
          promptId,
          messageId: readString(message.uuid) ?? null,
          text: delta.text,
        });
      }
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      events.push({
        kind: 'thinking_delta',
        sessionId,
        promptId,
        messageId: readString(message.uuid) ?? null,
        thinking: delta.thinking,
      });
    }
    return events;
  }

  const blocks = Array.isArray(message?.message?.content)
    ? message.message.content
    : Array.isArray(message?.content)
      ? message.content
      : [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') {
      const toolUseId = readString(block.id) ?? null;
      const toolName = readString(block.name) ?? 'unknown';
      if (toolName === 'TodoWrite' && !parentToolUseId) {
        const entries = extractTodoPlanEntries(block.input);
        if (entries) {
          events.push({
            kind: 'plan_updated',
            sessionId,
            promptId,
            entries,
          });
        }
      }
      events.push({
        kind: 'tool_call',
        sessionId,
        promptId,
        parentToolUseId,
        toolUseId,
        toolName,
        input: block.input ?? {},
      });
      if (toolUseId && SUBAGENT_TOOL_NAMES.has(toolName) && !subagentRegistry.has(toolUseId)) {
        subagentRegistry.set(toolUseId, {
          spawned: true,
          toolName,
          parentToolUseId: toolUseId,
        });
        events.push({
          kind: 'subagent/spawn',
          sessionId,
          promptId,
          subagentId: toolUseId,
          parentToolUseId: toolUseId,
          subagentType: readString(block.input?.subagent_type) ?? toolName,
          description: readString(block.input?.description ?? block.input?.prompt) ?? null,
        });
      }
    } else if (block.type === 'tool_result') {
      const toolUseId = readString(block.tool_use_id) ?? null;
      if (toolUseId && subagentRegistry.has(toolUseId)) {
        subagentRegistry.delete(toolUseId);
        events.push({
          kind: 'subagent/complete',
          sessionId,
          promptId,
          subagentId: toolUseId,
          parentToolUseId: toolUseId,
          status: block.is_error ? 'failed' : 'completed',
          summary: extractTextFromBlocks(block.content) ?? null,
        });
      }
      events.push({
        kind: 'tool_result',
        sessionId,
        promptId,
        parentToolUseId,
        toolUseId,
        isError: Boolean(block.is_error),
        content: block.content ?? null,
      });
    }
  }

  if (parentToolUseId && message.type === 'assistant') {
    const childText = extractTextFromBlocks(blocks);
    if (childText) {
      events.push({
        kind: 'subagent/update',
        sessionId,
        promptId,
        subagentId: parentToolUseId,
        parentToolUseId,
        text: childText,
      });
    }
  } else if (message.type === 'assistant') {
    events.push({
      kind: 'assistant_message',
      sessionId,
      promptId,
      uuid: readString(message.uuid) ?? null,
      text: extractTextFromBlocks(blocks) ?? '',
    });
  } else if (message.type === 'system' && message.subtype === 'init') {
    events.push({
      kind: 'session_initialized',
      sessionId,
      promptId,
      model: readString(message.model) ?? null,
      tools: Array.isArray(message.tools) ? message.tools : [],
      slashCommands: Array.isArray(message.slash_commands) ? message.slash_commands : [],
    });
  } else if (message.type === 'result') {
    if (message.is_error) {
      events.push({
        kind: 'turn_error',
        sessionId,
        promptId,
        uuid: readString(message.uuid) ?? null,
        subtype: readString(message.subtype) ?? 'error',
        message:
          readString(message.result ?? message.error) ?? 'Claude Agent SDK turn failed',
      });
    } else {
      events.push({
        kind: 'turn_completed',
        sessionId,
        promptId,
        uuid: readString(message.uuid) ?? null,
        subtype: readString(message.subtype) ?? 'success',
        stopReason: readString(message.stop_reason) ?? null,
        result: typeof message.result === 'string' ? message.result : null,
      });
    }
  } else if (message.type === 'error') {
    events.push({
      kind: 'turn_error',
      sessionId,
      promptId,
      message: readString(message.message ?? message.error?.message) ?? 'Claude SDK error',
    });
  }

  return events;
}
