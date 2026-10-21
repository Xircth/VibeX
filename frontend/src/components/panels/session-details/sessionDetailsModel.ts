import type {
  AgentSessionConfigOption,
  ConversationFileChange,
  MessageTurn,
  PlanEntry,
  SessionStats,
  SessionStatus,
  TimelineRow,
  TurnUsage,
} from 'shared/types';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';

export type SessionFileChange = {
  path: string;
  changeKind: string;
  additions: number | null;
  deletions: number | null;
  oldPath: string | null;
};

export type SessionChangeOverview = {
  files: SessionFileChange[];
  additions: number | null;
  deletions: number | null;
};

export type SessionMessageNavItem = {
  turnId: string;
  ordinal: number;
  preview: string;
  changes: SessionChangeOverview;
};

export type SessionUsageGroup = {
  key: string;
  label: string | null;
  tokens: number;
};

export type SessionMessageUsage = {
  turnId: string;
  ordinal: number;
  preview: string;
  tokens: number | null;
};

export type SessionUsageOverview = {
  totalTokens: number | null;
  /** Cache read divided by input + cache write + cache read. */
  cacheRate: number | null;
  truncated: boolean;
  /** True when at least one loaded turn reported its own protocol spend. */
  itemized: boolean;
  contextUsed: number | null;
  contextWindowMax: number | null;
  byModel: SessionUsageGroup[];
  byMessage: SessionMessageUsage[];
};

export type SessionDetailsFacts = {
  sessionId: string | null;
  hasDetail: boolean;
  error: string | null;
  title: string | null;
  status: SessionStatus | null;
  agentId: string | null;
  model: string | null;
  acpSessionId: string | null;
  externalSessionId: string | null;
  turnInFlight: boolean;
  sessionStats: SessionStats | null;
  truncated: boolean;
};

export type SessionDetailsModel =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      title: string | null;
      agentId: string | null;
      status: SessionStatus | null;
      model: string | null;
      branch: string | null;
      sessionId: string;
      extensionId: string | null;
      plan: PlanEntry[];
      activeMessageId: string | null;
      messages: SessionMessageNavItem[];
      usage: SessionUsageOverview;
    };

const PREVIEW_LIMIT = 80;

function finiteCount(
  value: bigint | number | string | null | undefined
): number | null {
  if (typeof value === 'bigint') {
    const next = Number(value);
    return Number.isSafeInteger(next) ? next : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const next = Number(value);
    return Number.isFinite(next) ? next : null;
  }
  return null;
}

/** Itemized token spend. All-zero usage is "not reported", not a real zero. */
export function protocolSpend(
  usage: TurnUsage | null | undefined
): number | null {
  if (!usage) return null;
  const total =
    Number(usage.input_tokens) +
    Number(usage.output_tokens) +
    Number(usage.cache_creation_input_tokens) +
    Number(usage.cache_read_input_tokens);
  if (!Number.isFinite(total) || total <= 0) return null;
  return total;
}

export function userMessagePreview(turn: MessageTurn): string {
  const text = turn.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return '';
  if (text.length <= PREVIEW_LIMIT) return text;
  return `${text.slice(0, PREVIEW_LIMIT)}…`;
}

export function advertisedModel(
  options: AgentSessionConfigOption[] | undefined
): string | null {
  const option = options?.find(
    (item) => item.category === 'model' || item.key === 'model'
  );
  if (typeof option?.value !== 'string') return null;
  const trimmed = option.value.trim();
  return trimmed || null;
}

export function resolveSessionModel(input: {
  summaryModel: string | null | undefined;
  configOptions: AgentSessionConfigOption[] | undefined;
}): string | null {
  const summary = input.summaryModel?.trim();
  if (summary) return summary;
  return advertisedModel(input.configOptions);
}

export function resolveExtensionId(input: {
  acpSessionId: string | null | undefined;
  externalSessionId: string | null | undefined;
}): string | null {
  const acp = input.acpSessionId?.trim();
  if (acp) return acp;
  const external = input.externalSessionId?.trim();
  return external || null;
}

export function resolveSessionStatus(input: {
  status: SessionStatus | null;
  turnInFlight: boolean;
}): SessionStatus | null {
  if (input.turnInFlight) return 'inprogress';
  return input.status;
}

export function latestPlanEntries(
  turns: ConversationTimelineTurn[]
): PlanEntry[] {
  let latest: PlanEntry[] = [];
  for (const row of turns) {
    for (const block of row.turn.blocks) {
      if (block.type === 'plan') {
        latest = block.entries;
      } else if (
        block.type === 'tool_use' &&
        (block.tool_name === 'TodoWrite' || block.tool_use_id === 'acp-plan') &&
        block.input_preview
      ) {
        try {
          const parsed = JSON.parse(block.input_preview) as {
            todos?: Array<{
              content?: string;
              status?: string;
              priority?: string;
            }>;
          };
          if (Array.isArray(parsed.todos)) {
            latest = parsed.todos
              .filter((todo) => typeof todo?.content === 'string')
              .map((todo) => ({
                content: todo.content ?? '',
                status: (todo.status ?? 'pending') as PlanEntry['status'],
                priority: (todo.priority ?? null) as PlanEntry['priority'],
              }));
          }
        } catch {
          // ignore malformed todo preview
        }
      }
    }
  }
  return latest;
}

export function messageNavItems(
  turns: ConversationTimelineTurn[]
): SessionMessageNavItem[] {
  const items: SessionMessageNavItem[] = [];
  for (const row of turns) {
    if (row.turn.role !== 'user' || row.turn.id.includes(':steer:')) continue;
    items.push({
      turnId: row.turn.id,
      ordinal: items.length + 1,
      preview: userMessagePreview(row.turn),
      changes: { files: [], additions: null, deletions: null },
    });
  }
  return items;
}

function addCount(
  current: number | null,
  next: bigint | number | null | undefined
): number | null {
  const value = finiteCount(next ?? null);
  if (current == null) return value;
  if (value == null) return current;
  return current + value;
}

function sumKnown(values: Array<number | null>): number | null {
  let total = 0;
  let any = false;
  for (const value of values) {
    if (value == null) continue;
    any = true;
    total += value;
  }
  return any ? total : null;
}

export function aggregateFileChanges(
  rows: TimelineRow[]
): SessionChangeOverview {
  const byPath = new Map<string, SessionFileChange>();
  for (const row of rows) {
    if (row.row.kind !== 'file_change_summary') continue;
    for (const file of row.row.summary.files) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, fileChangeFrom(file));
        continue;
      }
      existing.changeKind = file.change_kind;
      existing.additions = addCount(existing.additions, file.additions);
      existing.deletions = addCount(existing.deletions, file.deletions);
      if (file.old_path) existing.oldPath = file.old_path;
    }
  }
  const files = [...byPath.values()];
  return {
    files,
    additions: sumKnown(files.map((file) => file.additions)),
    deletions: sumKnown(files.map((file) => file.deletions)),
  };
}

function fileChangeFrom(file: ConversationFileChange): SessionFileChange {
  return {
    path: file.path,
    changeKind: file.change_kind,
    additions: finiteCount(file.additions),
    deletions: finiteCount(file.deletions),
    oldPath: file.old_path ?? null,
  };
}

function loadedProtocolTotal(turns: ConversationTimelineTurn[]): number | null {
  let total = 0;
  let any = false;
  for (const row of turns) {
    if (row.turn.role !== 'assistant') continue;
    const spend = protocolSpend(row.turn.usage);
    if (spend == null) continue;
    any = true;
    total += spend;
  }
  return any ? total : null;
}

function foldedProtocolTotal(stats: SessionStats | null): number | null {
  const total = finiteCount(stats?.total_tokens);
  return total != null && total > 0 ? total : null;
}

export function resolveReportedTotal(input: {
  turns: ConversationTimelineTurn[];
  sessionStats: SessionStats | null;
  truncated: boolean;
}): number | null {
  const loaded = loadedProtocolTotal(input.turns);
  const folded = foldedProtocolTotal(input.sessionStats);
  if (folded == null) return loaded;
  if (loaded == null) return folded;
  return Math.max(folded, loaded);
}

export function latestContextOccupancy(turns: ConversationTimelineTurn[]): {
  used: number | null;
  windowMax: number | null;
} {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const row = turns[index];
    const usage = row?.turn.usage;
    if (!row || row.turn.role !== 'assistant' || !usage) continue;
    const used = finiteCount(usage.context_used);
    const windowMax = finiteCount(usage.context_window_max);
    const reportedUsed = used != null && used > 0 ? used : null;
    const reportedWindow =
      windowMax != null && windowMax > 0 ? windowMax : null;
    if (reportedUsed == null && reportedWindow == null) continue;
    return { used: reportedUsed, windowMax: reportedWindow };
  }
  return { used: null, windowMax: null };
}

export function usageByModel(
  turns: ConversationTimelineTurn[]
): SessionUsageGroup[] {
  const groups = new Map<string, SessionUsageGroup>();
  for (const row of turns) {
    if (row.turn.role !== 'assistant') continue;
    const spend = protocolSpend(row.turn.usage);
    if (spend == null) continue;
    const model = row.turn.model?.trim() || null;
    const key = model ?? '';
    const current = groups.get(key) ?? { key, label: model, tokens: 0 };
    current.tokens += spend;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.tokens - left.tokens);
}

export function usageByMessage(
  turns: ConversationTimelineTurn[]
): SessionMessageUsage[] {
  const items: SessionMessageUsage[] = [];
  let current: SessionMessageUsage | null = null;
  for (const row of turns) {
    if (row.turn.role === 'user') {
      if (row.turn.id.includes(':steer:')) continue;
      current = {
        turnId: row.turn.id,
        ordinal: items.length + 1,
        preview: userMessagePreview(row.turn),
        tokens: null,
      };
      items.push(current);
      continue;
    }
    if (row.turn.role !== 'assistant' || !current) continue;
    const spend = protocolSpend(row.turn.usage);
    if (spend == null) continue;
    current.tokens = (current.tokens ?? 0) + spend;
  }
  return items;
}

type UsageBuckets = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

function bucketsFromUsage(
  usage: TurnUsage | null | undefined
): UsageBuckets | null {
  if (protocolSpend(usage) == null || !usage) return null;
  return {
    input: finiteCount(usage.input_tokens) ?? 0,
    output: finiteCount(usage.output_tokens) ?? 0,
    cacheWrite: finiteCount(usage.cache_creation_input_tokens) ?? 0,
    cacheRead: finiteCount(usage.cache_read_input_tokens) ?? 0,
  };
}

function addBuckets(left: UsageBuckets, right: UsageBuckets): UsageBuckets {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cacheRead: left.cacheRead + right.cacheRead,
  };
}

function bucketTotal(buckets: UsageBuckets): number {
  return (
    buckets.input + buckets.output + buckets.cacheWrite + buckets.cacheRead
  );
}

function loadedBuckets(turns: ConversationTimelineTurn[]): UsageBuckets | null {
  let total: UsageBuckets | null = null;
  for (const row of turns) {
    if (row.turn.role !== 'assistant') continue;
    const next = bucketsFromUsage(row.turn.usage);
    if (!next) continue;
    total = total ? addBuckets(total, next) : next;
  }
  return total;
}

/** Cache read / (uncached input + cache write + cache read). */
export function cacheRateFromBuckets(
  buckets: UsageBuckets | null
): number | null {
  if (!buckets) return null;
  const denominator = buckets.input + buckets.cacheWrite + buckets.cacheRead;
  if (denominator <= 0) return null;
  return buckets.cacheRead / denominator;
}

function withSessionDistribution(
  groups: SessionUsageGroup[],
  total: number | null,
  sessionModel: string | null
): SessionUsageGroup[] {
  if (total == null || total <= 0) return groups;
  if (groups.length === 0) {
    const label = sessionModel?.trim() || null;
    return [{ key: label ?? 'unattributed', label, tokens: total }];
  }
  const attributed = groups.reduce((sum, group) => sum + group.tokens, 0);
  if (attributed >= total) return groups;
  if (groups.length === 1) {
    const only = groups[0];
    if (!only) return groups;
    return [{ ...only, tokens: total }];
  }
  return [
    ...groups,
    { key: 'unattributed', label: null, tokens: total - attributed },
  ];
}

function stripTurnRole(id: string): string {
  return id.replace(/:(?:assistant(?::\d+)?|user)$/u, '');
}

function resolveUserMessageId(
  id: string | null | undefined,
  userIds: Set<string>
): string | null {
  if (!id) return null;
  const steer = /^(.*):steer:/u.exec(id);
  const candidate = steer?.[1] ?? id;
  if (!candidate.includes(':steer:') && userIds.has(candidate)) {
    return candidate;
  }
  const base = stripTurnRole(candidate);
  if (userIds.has(base)) return base;
  if (userIds.has(`${base}:user`)) return `${base}:user`;
  return null;
}

function sideRowTurnAliases(rowId: string): {
  userTurnId: string | null;
  assistantTurnId: string | null;
} {
  let userTurnId: string | null = null;
  let assistantTurnId: string | null = null;
  for (const segment of rowId.split('|').slice(1)) {
    if (segment.startsWith('user=')) {
      userTurnId = segment.slice('user='.length) || null;
    } else if (segment.startsWith('assistant=')) {
      assistantTurnId = segment.slice('assistant='.length) || null;
    }
  }
  return { userTurnId, assistantTurnId };
}

export function resolveActiveMessageId(input: {
  messages: Array<{ turnId: string }>;
  turns: ConversationTimelineTurn[];
  currentTurnId: string | null;
}): string | null {
  if (input.messages.length === 0) return null;
  const userIds = new Set(input.messages.map((message) => message.turnId));
  const direct = resolveUserMessageId(input.currentTurnId, userIds);
  if (direct) return direct;
  if (input.currentTurnId) {
    const index = input.turns.findIndex(
      (row) =>
        row.turn.id === input.currentTurnId ||
        stripTurnRole(row.turn.id) === stripTurnRole(input.currentTurnId ?? '')
    );
    if (index >= 0) {
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const row = input.turns[cursor];
        if (!row || row.turn.role !== 'user') continue;
        const resolved = resolveUserMessageId(row.turn.id, userIds);
        if (resolved) return resolved;
      }
    }
  }
  return input.messages[input.messages.length - 1]?.turnId ?? null;
}

function attachMessageChanges(
  messages: SessionMessageNavItem[],
  sideRows: TimelineRow[],
  activeMessageId: string | null
): SessionMessageNavItem[] {
  const userIds = new Set(messages.map((message) => message.turnId));
  const grouped = new Map<string, TimelineRow[]>();
  for (const row of sideRows) {
    if (row.row.kind !== 'file_change_summary') continue;
    const aliases = sideRowTurnAliases(row.row_id);
    const candidates = [
      aliases.userTurnId,
      row.row.turn_id,
      aliases.assistantTurnId,
    ];
    let target: string | null = null;
    for (const candidate of candidates) {
      target = resolveUserMessageId(candidate, userIds);
      if (target) break;
    }
    const scoped = candidates.some((candidate) => candidate);
    if (!target && !scoped) target = activeMessageId;
    if (!target) continue;
    const list = grouped.get(target) ?? [];
    list.push(row);
    grouped.set(target, list);
  }
  return messages.map((message) => ({
    ...message,
    changes: aggregateFileChanges(grouped.get(message.turnId) ?? []),
  }));
}

export function buildSessionDetails(input: {
  facts: SessionDetailsFacts;
  turns: ConversationTimelineTurn[];
  sideRows: TimelineRow[];
  branch: string | null;
  configOptions: AgentSessionConfigOption[];
  currentTurnId?: string | null;
}): SessionDetailsModel {
  if (!input.facts.sessionId) return { kind: 'empty' };
  if (!input.facts.hasDetail && input.facts.error) {
    return { kind: 'error', message: input.facts.error };
  }
  if (!input.facts.hasDetail) return { kind: 'loading' };

  const context = latestContextOccupancy(input.turns);
  const statsUsed = finiteCount(
    input.facts.sessionStats?.context_window_used_tokens
  );
  const statsMax = finiteCount(
    input.facts.sessionStats?.context_window_max_tokens
  );
  const sessionModel = resolveSessionModel({
    summaryModel: input.facts.model,
    configOptions: input.configOptions,
  });
  const messages = messageNavItems(input.turns);
  const activeMessageId = resolveActiveMessageId({
    messages,
    turns: input.turns,
    currentTurnId: input.currentTurnId ?? null,
  });
  const loaded = loadedBuckets(input.turns);
  const folded = bucketsFromUsage(input.facts.sessionStats?.total_usage);
  const totalTokens = resolveReportedTotal({
    turns: input.turns,
    sessionStats: input.facts.sessionStats,
    truncated: input.facts.truncated,
  });
  const loadedTotal = loaded ? bucketTotal(loaded) : null;
  const foldedTotal = foldedProtocolTotal(input.facts.sessionStats);
  const rateBuckets =
    loaded && loadedTotal != null && loadedTotal >= (foldedTotal ?? 0)
      ? loaded
      : folded;
  const byMessage = usageByMessage(input.turns);
  const turnModels = usageByModel(input.turns);
  const itemized =
    turnModels.length > 0 ||
    byMessage.some((message) => message.tokens != null);
  return {
    kind: 'ready',
    title: input.facts.title,
    agentId: input.facts.agentId,
    status: resolveSessionStatus({
      status: input.facts.status,
      turnInFlight: input.facts.turnInFlight,
    }),
    model: sessionModel,
    branch: input.branch?.trim() || null,
    sessionId: input.facts.sessionId,
    extensionId: resolveExtensionId({
      acpSessionId: input.facts.acpSessionId,
      externalSessionId: input.facts.externalSessionId,
    }),
    plan: latestPlanEntries(input.turns),
    activeMessageId,
    messages: attachMessageChanges(messages, input.sideRows, activeMessageId),
    usage: {
      totalTokens,
      cacheRate: cacheRateFromBuckets(rateBuckets),
      truncated: input.facts.truncated,
      itemized,
      contextUsed:
        context.used ?? (statsUsed != null && statsUsed > 0 ? statsUsed : null),
      contextWindowMax:
        context.windowMax ??
        (statsMax != null && statsMax > 0 ? statsMax : null),
      byModel: withSessionDistribution(turnModels, totalTokens, sessionModel),
      byMessage,
    },
  };
}
