import type { JsonValue } from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import { isRecord, readString } from './jsonValue';

export type SubagentStatus = 'running' | 'background' | 'completed' | 'failed';

export type SubagentCardModel = {
  title: string;
  subagentType: string | null;
  description: string | null;
  prompt: string | null;
  status: SubagentStatus;
  agentKind: string | null;
  toolCallCount: number | null;
  turnCount: number | null;
  durationMs: number | null;
  contextUsagePct: number | null;
  tokenCount: number | null;
  resultText: string | null;
};

const BACKGROUND_ACK =
  /subagent started in background|command running in background|background task\s+\S+\s+started/i;

export function canonicalToolName(name: string): string {
  return name.replace(/[\s._-]/g, '').toLowerCase();
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readNumber(
  record: Record<string, unknown> | null,
  keys: string[]
): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    const numberValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inputRecord(use: ToolUseBlock): Record<string, unknown> | null {
  const parsed = parseJson(use.input_preview);
  if (isRecord(parsed as JsonValue)) {
    return parsed as Record<string, unknown>;
  }
  return asObject(parsed);
}

function subagentMeta(use: ToolUseBlock): Record<string, unknown> | null {
  const meta = asObject(use.meta);
  return asObject(meta?.subagent) ?? asObject(meta?.grokSubagentProgress);
}

export type SubagentLifecycleKind = 'wait' | 'close';

export type SubagentLifecycleEvent = {
  kind: SubagentLifecycleKind;
  toolUseId: string | null;
  bindingIds: string[];
  inFlight: boolean;
  failed: boolean;
  resultText: string | null;
  childStatus: SubagentStatus | null;
  toolCallCount: number | null;
  turnCount: number | null;
  durationMs: number | null;
  contextUsagePct: number | null;
  tokenCount: number | null;
};

const LIFECYCLE_WAIT_NAMES = new Set([
  'waitagent',
  'wait',
  'getdelegationstatus',
  'getcommandorsubagentoutput',
  'getsubagentoutput',
]);
const LIFECYCLE_CLOSE_NAMES = new Set([
  'closeagent',
  'close',
  'canceldelegation',
]);

const KNOWN_AGENT_KINDS = new Set([
  'claude_code',
  'codex',
  'opencode',
  'antigravity',
  'gemini',
  'openclaw',
  'cline',
  'hermes',
  'codebuddy',
  'kimi_code',
  'kimi',
  'pi',
  'grok',
  'cursor',
  'deepseek_harness',
  'qa_mock',
]);

const AGENT_KIND_ALIASES: Record<string, string> = {
  open_code: 'opencode',
  opencode: 'opencode',
  open_claw: 'openclaw',
  openclaw: 'openclaw',
  claudecode: 'claude_code',
  kimi: 'kimi_code',
  kimicode: 'kimi_code',
  xai: 'grok',
  'x.ai': 'grok',
};

export function isHostDelegationTool(use: ToolUseBlock): boolean {
  return canonicalToolName(use.tool_name) === 'delegatetoagent';
}

export function isHostDelegationLifecycleTool(use: ToolUseBlock): boolean {
  const name = canonicalToolName(use.tool_name);
  return name === 'getdelegationstatus' || name === 'canceldelegation';
}

export function isNativeSubagentTool(use: ToolUseBlock): boolean {
  if (isHostDelegationTool(use) || isHostDelegationLifecycleTool(use)) {
    return false;
  }
  const input = inputRecord(use);
  const vendorName = readString(
    asObject(asObject(use.meta)?.['x.ai/tool']) as JsonValue,
    'name'
  );
  if (vendorName === 'spawn_subagent') return true;
  const name = canonicalToolName(use.tool_name);
  if (LIFECYCLE_WAIT_NAMES.has(name) || LIFECYCLE_CLOSE_NAMES.has(name)) {
    return false;
  }
  if (
    readString(input as JsonValue, [
      'subagent_type',
      'agent_type',
      'subagentType',
    ])
  ) {
    return true;
  }
  return (
    name === 'spawnsubagent' ||
    name === 'spawnagent' ||
    name === 'subagentlaunch'
  );
}

export function subagentLifecycleKind(
  use: ToolUseBlock
): SubagentLifecycleKind | null {
  const name = canonicalToolName(use.tool_name);
  if (LIFECYCLE_WAIT_NAMES.has(name)) {
    return name === 'wait' && collectBindingIds(use, null).length === 0
      ? null
      : 'wait';
  }
  if (LIFECYCLE_CLOSE_NAMES.has(name)) {
    return name === 'close' && collectBindingIds(use, null).length === 0
      ? null
      : 'close';
  }
  return null;
}

export function isSubagentLifecycleTool(use: ToolUseBlock): boolean {
  return subagentLifecycleKind(use) !== null;
}

function pushBindingId(ids: string[], value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    ids.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushBindingId(ids, item);
  }
}

export function collectBindingIds(
  use: ToolUseBlock,
  result: ToolResultBlock | null
): string[] {
  const ids: string[] = [];
  const input = inputRecord(use);
  if (input) {
    pushBindingId(ids, input.agent_id);
    pushBindingId(ids, input.agentId);
    pushBindingId(ids, input.thread_id);
    pushBindingId(ids, input.threadId);
    pushBindingId(ids, input.agent_ids);
    pushBindingId(ids, input.agentIds);
    pushBindingId(ids, input.thread_ids);
    pushBindingId(ids, input.task_id);
    pushBindingId(ids, input.taskId);
    pushBindingId(ids, input.task_ids);
    pushBindingId(ids, input.subagent_id);
    pushBindingId(ids, input.subagentId);
  }
  const output = parseJson(result?.output_preview ?? null);
  const outputRecord = asObject(output);
  if (outputRecord) {
    pushBindingId(ids, outputRecord.agent_id);
    pushBindingId(ids, outputRecord.agentId);
    pushBindingId(ids, outputRecord.thread_id);
    pushBindingId(ids, outputRecord.threadId);
    pushBindingId(ids, outputRecord.task_id);
    pushBindingId(ids, outputRecord.taskId);
    pushBindingId(ids, outputRecord.subagent_id);
    pushBindingId(ids, outputRecord.subagentId);
    const tasks = outputRecord.tasks;
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        const record = asObject(task);
        if (!record) continue;
        pushBindingId(ids, record.task_id);
        pushBindingId(ids, record.taskId);
        pushBindingId(ids, record.agent_id);
        pushBindingId(ids, record.subagent_id);
      }
    }
  }
  const outputText =
    typeof result?.output_preview === 'string' ? result.output_preview : '';
  const fromText = outputText.matchAll(
    /(?:agent|thread|task|subagent)[_-]?id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/gi
  );
  for (const match of fromText) {
    if (match[1]) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export function parseSubagentLifecycleEvent(
  use: ToolUseBlock,
  result: ToolResultBlock | null
): SubagentLifecycleEvent | null {
  const kind = subagentLifecycleKind(use);
  if (!kind) return null;
  const facts = parseLifecycleFacts(result);
  return {
    kind,
    toolUseId: use.tool_use_id ?? null,
    bindingIds: collectBindingIds(use, result),
    inFlight: result == null,
    failed: result?.is_error === true || facts.childStatus === 'failed',
    resultText: facts.resultText,
    childStatus: facts.childStatus,
    toolCallCount: facts.toolCallCount,
    turnCount: facts.turnCount,
    durationMs: facts.durationMs,
    contextUsagePct: facts.contextUsagePct,
    tokenCount: facts.tokenCount,
  };
}

export function foldSubagentLifecycle(
  tools: Array<{ use: ToolUseBlock; result: ToolResultBlock | null }>,
  extraEvents: SubagentLifecycleEvent[] = []
): {
  cards: Array<{
    use: ToolUseBlock;
    result: ToolResultBlock | null;
    lifecycle: SubagentLifecycleEvent[];
  }>;
  hiddenToolUseIds: Set<string>;
} {
  const cards: Array<{
    use: ToolUseBlock;
    result: ToolResultBlock | null;
    lifecycle: SubagentLifecycleEvent[];
    bindingIds: string[];
  }> = [];
  const events: SubagentLifecycleEvent[] = [];

  for (const tool of tools) {
    if (isNativeSubagentTool(tool.use)) {
      cards.push({
        use: tool.use,
        result: tool.result,
        lifecycle: [],
        bindingIds: collectBindingIds(tool.use, tool.result),
      });
      continue;
    }
    const event = parseSubagentLifecycleEvent(tool.use, tool.result);
    if (event) events.push(event);
  }

  const hiddenToolUseIds = new Set<string>();
  const remainingLocal = [...events];
  const remainingExtra = [...extraEvents];

  for (const card of cards) {
    const attached: SubagentLifecycleEvent[] = [];
    const takeMatches = (
      pool: SubagentLifecycleEvent[],
      allowPositional: boolean
    ) => {
      for (let index = 0; index < pool.length; ) {
        const event = pool[index];
        const matchesById =
          event.bindingIds.length > 0 &&
          card.bindingIds.some((id) => event.bindingIds.includes(id));
        if (matchesById) {
          attached.push(event);
          pool.splice(index, 1);
          continue;
        }
        index += 1;
      }
      if (attached.length === 0 && allowPositional) {
        const positional = pool.findIndex(
          (event) =>
            event.bindingIds.length === 0 || card.bindingIds.length === 0
        );
        if (positional >= 0) attached.push(pool.splice(positional, 1)[0]);
      }
    };
    takeMatches(remainingLocal, true);
    takeMatches(remainingExtra, false);
    card.lifecycle = attached;
    for (const event of attached) {
      if (event.toolUseId) hiddenToolUseIds.add(event.toolUseId);
    }
  }

  for (const event of remainingExtra) {
    if (
      event.toolUseId &&
      cards.some((card) =>
        card.bindingIds.some((id) => event.bindingIds.includes(id))
      )
    ) {
      hiddenToolUseIds.add(event.toolUseId);
    }
  }

  return {
    cards: cards.map(({ use, result, lifecycle }) => ({
      use,
      result,
      lifecycle,
    })),
    hiddenToolUseIds,
  };
}

export function collectSubagentLifecycleIndex(
  tools: Array<{ use: ToolUseBlock; result: ToolResultBlock | null }>
): {
  events: SubagentLifecycleEvent[];
  spawnBindingIds: Set<string>;
} {
  const events: SubagentLifecycleEvent[] = [];
  const spawnBindingIds = new Set<string>();
  for (const tool of tools) {
    if (isNativeSubagentTool(tool.use)) {
      for (const id of collectBindingIds(tool.use, tool.result)) {
        spawnBindingIds.add(id);
      }
      continue;
    }
    const event = parseSubagentLifecycleEvent(tool.use, tool.result);
    if (event) events.push(event);
  }
  return { events, spawnBindingIds };
}

export function shouldHideLifecycleTool(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  spawnBindingIds: Set<string>
): boolean {
  const event = parseSubagentLifecycleEvent(use, result);
  if (!event) return false;
  return event.bindingIds.some((id) => spawnBindingIds.has(id));
}

export function applySubagentLifecycle(
  model: SubagentCardModel,
  lifecycle: SubagentLifecycleEvent[]
): SubagentCardModel {
  if (lifecycle.length === 0) return model;
  const lastWait = [...lifecycle]
    .reverse()
    .find((event) => event.kind === 'wait');
  const lastClose = [...lifecycle]
    .reverse()
    .find((event) => event.kind === 'close');
  const failed = lifecycle.some((event) => event.failed);
  const waiting = lifecycle.some(
    (event) => event.kind === 'wait' && event.inFlight
  );
  const closed = lastClose != null && !lastClose.inFlight && !lastClose.failed;
  const waited = lastWait != null && !lastWait.inFlight && !lastWait.failed;
  const latestFacts = [...lifecycle].reverse().find((event) => !event.inFlight);

  let status: SubagentStatus = model.status;
  if (failed) status = 'failed';
  else if (waiting)
    status = model.status === 'background' ? 'background' : 'running';
  else if (lastWait?.childStatus === 'running')
    status = model.status === 'background' ? 'background' : 'running';
  else if (lastWait?.childStatus === 'completed') status = 'completed';
  else if (waited || closed) status = 'completed';

  const resultText =
    status === 'completed' || status === 'failed'
      ? (lastWait?.resultText ?? lastClose?.resultText ?? model.resultText)
      : null;

  return {
    ...model,
    status,
    resultText,
    toolCallCount: latestFacts?.toolCallCount ?? model.toolCallCount,
    turnCount: latestFacts?.turnCount ?? model.turnCount,
    durationMs: latestFacts?.durationMs ?? model.durationMs,
    contextUsagePct: latestFacts?.contextUsagePct ?? model.contextUsagePct,
    tokenCount: latestFacts?.tokenCount ?? model.tokenCount,
  };
}

function progressRecord(
  use: ToolUseBlock,
  result: ToolResultBlock | null
): Record<string, unknown> | null {
  const fromMeta = asObject(subagentMeta(use)?.progress) ?? subagentMeta(use);
  const topMeta = asObject(use.meta);
  const merged: Record<string, unknown> = {
    ...(fromMeta ?? {}),
  };
  if (topMeta) {
    const durationMs = readDurationMs(topMeta);
    if (merged.durationMs == null && durationMs != null) {
      merged.durationMs = durationMs;
    }
    if (merged.tokenCount == null && topMeta.token_count != null) {
      merged.tokenCount = topMeta.token_count;
    }
  }
  const fromOutput = asObject(
    parseJson(result?.output_preview ?? null) as unknown
  );
  const envelope = unwrapEnvelope(fromOutput);
  if (envelope) {
    const durationMs = readElapsedMs(envelope);
    if (merged.durationMs == null && durationMs != null) {
      merged.durationMs = durationMs;
    }
  }
  const stats = asObject(result?.agent_stats);
  if (stats) {
    return {
      durationMs: stats.total_duration_ms,
      toolCallCount: stats.total_tool_use_count,
      tokenCount: stats.total_tokens,
      ...merged,
    };
  }
  return Object.keys(merged).length > 0 ? merged : fromMeta;
}

function readDeclaredStatus(use: ToolUseBlock): string | null {
  return (
    readString(subagentMeta(use) as JsonValue, 'status') ??
    readString(asObject(use.meta) as JsonValue, 'status')
  );
}

function coerceStatus(value: string | null | undefined): SubagentStatus | null {
  if (
    value === 'running' ||
    value === 'background' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  if (value === 'canceled' || value === 'cancelled' || value === 'error') {
    return value === 'error' ? 'failed' : 'failed';
  }
  return null;
}

function inferStatus(
  use: ToolUseBlock,
  result: ToolResultBlock | null
): SubagentStatus {
  const declared = coerceStatus(readDeclaredStatus(use));
  if (declared) return declared;
  if (result?.is_error) return 'failed';
  if (!result) return 'running';
  const launchAck = parseLifecycleFacts(result);
  if (launchAck.childStatus) return launchAck.childStatus;
  const input = inputRecord(use);
  const background =
    input?.background === true ||
    BACKGROUND_ACK.test(result.output_preview ?? '');
  if (background) return 'background';
  return 'completed';
}

function stripScaffolding(output: string | null): string | null {
  if (!output) return output;
  const stripped = output
    .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/gi, '')
    .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped.length > 0 ? stripped : null;
}

const DISPLAY_TEXT_KEYS = ['output', 'text', 'message', 'content'];

function isLaunchAckText(text: string): boolean {
  return (
    BACKGROUND_ACK.test(text) ||
    /^\s*\{[\s\S]*"status"\s*:\s*"(?:running|started)"/i.test(text)
  );
}

function unwrapEnvelope(
  value: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!value) return null;
  const nested = asObject(value.Result) ?? asObject(value.result);
  if (!nested) return value;
  const type = typeof value.type === 'string' ? value.type : '';
  if (
    type === 'TaskOutput' ||
    type === 'SubagentCompleted' ||
    type === 'SubagentResult' ||
    nested.output != null ||
    nested.text != null ||
    nested.status != null
  ) {
    return nested;
  }
  return value;
}

function extractDisplayText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isLaunchAckText(trimmed)) return null;
    const parsed = parseJson(trimmed);
    if (parsed != null && typeof parsed !== 'string') {
      const nested = extractDisplayText(parsed, depth + 1);
      if (nested) return nested;
      if (asObject(parsed)) return null;
    }
    return stripScaffolding(trimmed);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractDisplayText(item, depth + 1);
      if (text) return text;
    }
    return null;
  }
  const record = unwrapEnvelope(asObject(value));
  if (!record) return null;
  for (const key of DISPLAY_TEXT_KEYS) {
    const text = extractDisplayText(record[key], depth + 1);
    if (text) return text;
  }
  if (typeof record.result === 'string') {
    return extractDisplayText(record.result, depth + 1);
  }
  return null;
}

export function extractSubagentResultText(
  output: string | null
): string | null {
  return extractDisplayText(output);
}

function readTimestampMs(
  record: Record<string, unknown> | null,
  keys: string[]
): number | null {
  const value = readString(record as JsonValue, keys);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readElapsedMs(record: Record<string, unknown> | null): number | null {
  const started = readTimestampMs(record, [
    'started',
    'started_at',
    'startedAt',
    'start_time',
  ]);
  const ended = readTimestampMs(record, [
    'ended',
    'ended_at',
    'endedAt',
    'end_time',
  ]);
  if (started != null && ended != null && ended >= started) {
    return ended - started;
  }
  return readDurationMs(record);
}

function readDurationMs(record: Record<string, unknown> | null): number | null {
  const ms = readNumber(record, [
    'durationMs',
    'duration_ms',
    'total_duration_ms',
  ]);
  if (ms != null) return ms;
  const seconds = readNumber(record, ['duration_secs', 'durationSecs']);
  return seconds != null ? seconds * 1000 : null;
}

function firstTaskRecord(
  value: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!value) return null;
  if (Array.isArray(value.tasks)) {
    const first = value.tasks.find((item) => asObject(item));
    return unwrapEnvelope(asObject(first));
  }
  return unwrapEnvelope(value);
}

function parseLifecycleFacts(result: ToolResultBlock | null): {
  childStatus: SubagentStatus | null;
  resultText: string | null;
  toolCallCount: number | null;
  turnCount: number | null;
  durationMs: number | null;
  contextUsagePct: number | null;
  tokenCount: number | null;
} {
  const parsed = parseJson(result?.output_preview ?? null);
  const root = asObject(parsed);
  const task = firstTaskRecord(root);
  const progress = asObject(task?.progress) ?? task ?? root;
  const childStatus =
    coerceStatus(readString(task as JsonValue, 'status')) ??
    coerceStatus(readString(root as JsonValue, 'status'));
  const resultText =
    childStatus === 'running'
      ? null
      : (extractDisplayText(task) ??
        extractDisplayText(parsed) ??
        extractDisplayText(result?.output_preview ?? null));
  return {
    childStatus,
    resultText,
    toolCallCount: readNumber(progress, [
      'toolCallCount',
      'tool_call_count',
      'tool_calls',
    ]),
    turnCount: readNumber(progress, ['turnCount', 'turn_count']),
    durationMs: readElapsedMs(progress),
    contextUsagePct: readNumber(progress, [
      'contextUsagePct',
      'context_usage_pct',
    ]),
    tokenCount: readNumber(progress, [
      'tokenCount',
      'tokens_used',
      'token_count',
      'total_tokens',
    ]),
  };
}

export function normalizeAgentKind(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const compact = canonicalToolName(raw);
  const aliased = AGENT_KIND_ALIASES[raw] ?? AGENT_KIND_ALIASES[compact] ?? raw;
  if (KNOWN_AGENT_KINDS.has(aliased)) return aliased;
  if (KNOWN_AGENT_KINDS.has(compact)) return compact;
  return null;
}

export function resolveSubagentAgentKind(
  use: ToolUseBlock,
  parentAgentId?: string | null
): string | null {
  const input = inputRecord(use);
  const fromInput = normalizeAgentKind(
    readString(input as JsonValue, ['agent_type', 'agentType', 'agent'])
  );
  if (fromInput) return fromInput;
  const fromMeta = normalizeAgentKind(
    readString(asObject(use.meta) as JsonValue, ['agent_type', 'agentType']) ??
      readString(subagentMeta(use) as JsonValue, ['agent_type', 'agentType'])
  );
  if (fromMeta) return fromMeta;
  const vendorName = readString(
    asObject(asObject(use.meta)?.['x.ai/tool']) as JsonValue,
    'name'
  );
  const name = canonicalToolName(use.tool_name);
  if (vendorName === 'spawn_subagent' || name === 'spawnsubagent') {
    return 'grok';
  }
  return normalizeAgentKind(parentAgentId);
}

export function buildSubagentCardModel(
  use: ToolUseBlock,
  result: ToolResultBlock | null,
  parentAgentId?: string | null
): SubagentCardModel {
  const input = inputRecord(use);
  const agentKind = resolveSubagentAgentKind(use, parentAgentId);
  const subagentType =
    readString(input as JsonValue, ['subagent_type', 'subagentType']) ??
    (normalizeAgentKind(
      readString(input as JsonValue, ['agent_type', 'agentType'])
    )
      ? null
      : readString(input as JsonValue, ['agent_type', 'agentType']));
  const description =
    readString(input as JsonValue, ['description', 'title', 'name']) ?? null;
  const prompt = readString(input as JsonValue, ['prompt', 'task', 'input']);
  const progress = progressRecord(use, result);
  const title = subagentType
    ? description
      ? `${subagentType}: ${description}`
      : subagentType
    : (description ?? agentKind ?? use.tool_name);
  const status = inferStatus(use, result);

  return {
    title,
    subagentType,
    description,
    prompt,
    status,
    agentKind,
    toolCallCount: readNumber(progress, ['toolCallCount', 'tool_call_count']),
    turnCount: readNumber(progress, ['turnCount', 'turn_count']),
    durationMs: readElapsedMs(progress),
    contextUsagePct: readNumber(progress, [
      'contextUsagePct',
      'context_usage_pct',
    ]),
    tokenCount: readNumber(progress, [
      'tokenCount',
      'tokens_used',
      'total_tokens',
    ]),
    resultText:
      status === 'completed' || status === 'failed'
        ? extractSubagentResultText(result?.output_preview ?? null)
        : null,
  };
}

export function formatSubagentDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60)
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = seconds / 60;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)}m`;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
