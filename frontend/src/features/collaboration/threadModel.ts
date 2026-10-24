import type { CrossChatNotice } from './spaceModel';
/**
 * View model for the member + group-chat collaboration UI.
 *
 * Only two concepts reach the UI: a **member** (long-lived identity with its
 * own memory) and a **group chat**. Backend "spaces" are group chats; the
 * undecided space holds each member's direct thread.
 */

export type MemberPresence = 'idle' | 'busy' | 'queued' | 'sleeping';

export type ThreadKind = 'member' | 'group';

export type ThreadSeat = {
  /** Space id of the group chat, or the undecided space for the direct seat. */
  threadId: string;
  threadName: string;
  conversationId: string | null;
  direct: boolean;
};

export type ConversationFacts = {
  conversation_id: string;
  agent_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
  turn_in_flight?: boolean;
};

export type ThreadMember = {
  memberId: string;
  nickname: string;
  seats: ThreadSeat[];
};

export type ThreadGroup = {
  spaceId: string;
  name: string;
  memberIds: string[];
};

export type ThreadActivity = {
  /** ISO timestamp of the latest message/turn. */
  at?: string | null;
  text?: string | null;
  unread?: number;
  /** Shown as a ⚠ on the row (worktree conflict). */
  warning?: boolean;
};

export type PresenceView = {
  state: MemberPresence;
  /** Status line, e.g. `正在 #登录重构 处理… 另 1 个排队`. */
  line: string | null;
  busyThreads: string[];
  queued: number;
};

export type ThreadListItem =
  | {
      kind: 'member';
      key: string;
      member: ThreadMember;
      presence: PresenceView;
      attention: number;
      pinned: boolean;
      activity: ThreadActivity;
    }
  | {
      kind: 'group';
      key: string;
      group: ThreadGroup;
      pinned: boolean;
      activity: ThreadActivity;
      attention: number;
    };

export type ThreadFilter = 'all' | 'member' | 'group';

export const THREAD_COPY = {
  title: '协作',
  filterAll: '全部',
  filterMembers: '成员',
  filterGroups: '群聊',
  searchPlaceholder: '搜索成员或群聊…',
  groupPill: (count: number) => `群聊·${count}`,
  idle: '空闲',
  sleeping: '休眠中 · 发消息即唤醒',
  busy: (thread: string) => `正在 #${thread} 处理…`,
  queuedTail: (count: number) => `另 ${count} 个排队`,
  queuedOnly: (count: number) => `${count} 条消息排队中`,
  needsYou: '等你处理',
  pin: '置顶',
  unpin: '取消置顶',
  newGroup: '新建群聊',
  newMember: '新建成员',
  emptyList: '还没有成员或群聊',
  emptySearch: '没有匹配的成员或群聊',
  you: '你',
  process: (steps: number) => `执行过程 · ${steps} 步`,
  processTools: (tools: number) => `${tools} 个工具`,
  viewProcess: '查看过程',
  hideProcess: '收起过程',
  openSession: '在会话标签中打开',
  moreSteps: (count: number) => `另外 ${count} 步`,
  receiptQueued: '排队中',
  receiptWaking: '唤醒中',
  receiptProcessing: '处理中',
  receiptReplied: '已回复',
  receiptLimit: '已达唤醒上限',
  receiptFailed: '失败',
  retry: '重试',
  directUnaffected: '本私聊不受影响',
  busyElsewhere: (name: string, thread: string) =>
    `${name} 同时在 #${thread} 中忙碌`,
  willQueue: (thread: string) => `正在 #${thread} 处理 · 将排队`,
  willWake: '将唤醒',
  willWakeSleeping: '休眠中 · 将唤醒',
  wakeConfirm: (count: number, asleep: number) =>
    asleep > 0
      ? `将唤醒 ${count} 个成员（含休眠中的 ${asleep} 个）`
      : `将唤醒 ${count} 个成员`,
  wakeConfirmSend: '仍然发送',
  wakeConfirmMention: '改为 @ 指定',
  agentFold: (count: number, pair: string) =>
    `成员间消息 ${count} 条已折叠（${pair}）`,
  agentUnfold: '收起成员间消息',
  handoffTitle: '交接',
  handoffDone: '已完成',
  handoffInputs: '输入与约束',
  handoffAsk: '需要你做',
  approvalTitle: '请求审批',
  approvalOnce: '允许一次',
  approvalDeny: '拒绝',
  askTitle: '提问',
  askOther: '回复其他…',
  askSubmit: '回复',
  resolvedAnswer: (answer: string) => `已回复：${answer}`,
  resolvedDecision: (label: string) => `已处理：${label}`,
  conflictTitle: 'Worktree 冲突',
  conflictNew: '新建 worktree',
  conflictWait: '排队等待',
  conflictView: '查看占用',
  composerPlaceholder: '发消息，@ 指定成员',
  send: '发送',
} as const;

const PINS_STORAGE_KEY = 'vibex-collaboration-thread-pins';

export function readThreadPins(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(PINS_STORAGE_KEY) ?? '[]'
    );
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

export function writeThreadPins(
  pins: readonly string[],
  storage: Pick<Storage, 'setItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): void {
  try {
    storage?.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Ignore quota errors.
  }
}

export function togglePin(pins: readonly string[], key: string): string[] {
  return pins.includes(key)
    ? pins.filter((pin) => pin !== key)
    : [key, ...pins];
}

export function memberKey(memberId: string): string {
  return `member:${memberId}`;
}

export function groupKey(spaceId: string): string {
  return `group:${spaceId}`;
}

/**
 * Presence across all of a member's seats. Sleeping only applies when no seat
 * is busy or queued; busy shows the most recently active thread plus a count
 * of queued messages elsewhere.
 */
export function memberPresence(
  member: ThreadMember,
  conversations: ReadonlyMap<string, ConversationFacts>,
  queuedByConversation: ReadonlyMap<string, number> = new Map()
): PresenceView {
  const seats = member.seats.filter((seat) => seat.conversationId);
  const busy = seats
    .map((seat) => ({
      seat,
      facts: conversations.get(seat.conversationId ?? ''),
    }))
    .filter(({ facts }) => facts?.turn_in_flight)
    .sort((a, b) =>
      String(b.facts?.updated_at ?? '').localeCompare(
        String(a.facts?.updated_at ?? '')
      )
    );
  const queued = seats.reduce(
    (sum, seat) =>
      sum + (queuedByConversation.get(seat.conversationId ?? '') ?? 0),
    0
  );
  const busyThreads = busy.map(({ seat }) => seat.threadName);
  if (busy.length > 0) {
    const head = busy[0].seat;
    const label = head.direct ? '私聊' : head.threadName;
    const extra = busy.length - 1 + queued;
    return {
      state: 'busy',
      line:
        extra > 0
          ? `${THREAD_COPY.busy(label)} ${THREAD_COPY.queuedTail(extra)}`
          : THREAD_COPY.busy(label),
      busyThreads,
      queued,
    };
  }
  if (queued > 0) {
    return {
      state: 'queued',
      line: THREAD_COPY.queuedOnly(queued),
      busyThreads,
      queued,
    };
  }
  const sleeping =
    seats.length > 0 &&
    seats.every((seat) => {
      const status = conversations.get(seat.conversationId ?? '')?.status;
      return status === 'sleeping' || status === 'asleep';
    });
  if (sleeping) {
    return {
      state: 'sleeping',
      line: THREAD_COPY.sleeping,
      busyThreads,
      queued,
    };
  }
  return { state: 'idle', line: null, busyThreads, queued };
}

/** Flat list of members and group chats: pinned first, then most recent. */
export function buildThreadList({
  members,
  groups,
  conversations,
  activity,
  pins,
  attentionByMember = new Map(),
  queuedByConversation,
  filter = 'all',
  query = '',
}: {
  members: readonly ThreadMember[];
  groups: readonly ThreadGroup[];
  conversations: ReadonlyMap<string, ConversationFacts>;
  activity: Readonly<Record<string, ThreadActivity>>;
  pins: readonly string[];
  attentionByMember?: ReadonlyMap<string, number>;
  queuedByConversation?: ReadonlyMap<string, number>;
  filter?: ThreadFilter;
  query?: string;
}): ThreadListItem[] {
  const needle = query.trim().toLowerCase();
  const items: ThreadListItem[] = [];
  if (filter !== 'group') {
    for (const member of members) {
      const key = memberKey(member.memberId);
      if (needle && !member.nickname.toLowerCase().includes(needle)) continue;
      items.push({
        kind: 'member',
        key,
        member,
        presence: memberPresence(member, conversations, queuedByConversation),
        attention: attentionByMember.get(member.memberId) ?? 0,
        pinned: pins.includes(key),
        activity: activity[key] ?? {},
      });
    }
  }
  if (filter !== 'member') {
    for (const group of groups) {
      const key = groupKey(group.spaceId);
      if (needle && !group.name.toLowerCase().includes(needle)) continue;
      const attention = group.memberIds.reduce(
        (sum, id) => sum + (attentionByMember.get(id) ?? 0),
        0
      );
      items.push({
        kind: 'group',
        key,
        group,
        pinned: pins.includes(key),
        activity: activity[key] ?? {},
        attention,
      });
    }
  }
  return items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return pins.indexOf(a.key) - pins.indexOf(b.key);
    const at = String(b.activity.at ?? '').localeCompare(
      String(a.activity.at ?? '')
    );
    if (at !== 0) return at;
    return a.kind === b.kind ? 0 : a.kind === 'member' ? -1 : 1;
  });
}

/** Group members by `member_id` across every space they sit in. */
export function collectMembers(
  spaces: readonly { space_id: string; name: string }[],
  membersBySpace: Readonly<
    Record<
      string,
      readonly {
        member_id?: string;
        nickname?: string;
        kind?: string;
        conversation_id?: string | null;
      }[]
    >
  >,
  directSpaceId: string
): { members: ThreadMember[]; groups: ThreadGroup[] } {
  const byId = new Map<string, ThreadMember>();
  const groups: ThreadGroup[] = [];
  const visit = (spaceId: string, name: string, direct: boolean) => {
    const ids: string[] = [];
    for (const seat of membersBySpace[spaceId] ?? []) {
      if (seat.kind !== 'agent') continue;
      const memberId =
        seat.member_id || seat.conversation_id || seat.nickname || '';
      if (!memberId) continue;
      ids.push(memberId);
      const entry = byId.get(memberId) ?? {
        memberId,
        nickname: String(seat.nickname ?? ''),
        seats: [],
      };
      entry.seats.push({
        threadId: spaceId,
        threadName: name,
        conversationId: seat.conversation_id ?? null,
        direct,
      });
      if (direct && seat.nickname) entry.nickname = seat.nickname;
      byId.set(memberId, entry);
    }
    return ids;
  };
  if (directSpaceId) visit(directSpaceId, '', true);
  for (const space of spaces) {
    if (space.space_id === directSpaceId) continue;
    groups.push({
      spaceId: space.space_id,
      name: space.name,
      memberIds: visit(space.space_id, space.name, false),
    });
  }
  return { members: Array.from(byId.values()), groups };
}

export type HandoffView = {
  id: string | null;
  depth: number | null;
  done: string;
  inputsConstraints: string;
  ask: string;
};

function tag(body: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return decodeEntities(match?.[1]?.trim() ?? '');
}

function attr(head: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(head);
  return match ? decodeEntities(match[1]) : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse a `<handoff>` message body into its three sections. */
export function parseHandoff(
  text: string | null | undefined
): HandoffView | null {
  const match = /<handoff\b([^>]*)>([\s\S]*?)<\/handoff>/.exec(
    String(text ?? '')
  );
  if (!match) return null;
  const depth = attr(match[1], 'depth');
  return {
    id: attr(match[1], 'id'),
    depth:
      depth != null && Number.isFinite(Number(depth)) ? Number(depth) : null,
    done: tag(match[2], 'done'),
    inputsConstraints: tag(match[2], 'inputs_constraints'),
    ask: tag(match[2], 'ask'),
  };
}

export type CardView =
  | { kind: 'ask'; id: string; question: string; options: string[] }
  | {
      kind: 'approval';
      id: string;
      action: string;
      command: string;
      reason: string;
    };

/** Parse a `<card kind=..>` message body posted by ask_person/request_approval. */
export function parseCard(text: string | null | undefined): CardView | null {
  const match = /<card\b([^>]*)>([\s\S]*?)<\/card>/.exec(String(text ?? ''));
  if (!match) return null;
  const kind = attr(match[1], 'kind');
  const id = attr(match[1], 'id') ?? '';
  if (kind === 'ask') {
    const options = tag(match[2], 'options');
    return {
      kind,
      id,
      question: tag(match[2], 'question'),
      options: options
        ? options
            .split('|')
            .map((o) => o.trim())
            .filter(Boolean)
        : [],
    };
  }
  if (kind === 'approval') {
    return {
      kind,
      id,
      action: tag(match[2], 'action'),
      command: tag(match[2], 'command'),
      reason: tag(match[2], 'reason'),
    };
  }
  return null;
}

export type WorktreeConflictView = {
  holder: string;
  branch: string;
  path: string;
};

/** `<worktree_conflict holder=".." branch=".." path=".."/>` system notice. */
export function parseWorktreeConflict(
  text: string | null | undefined
): WorktreeConflictView | null {
  const match = /<worktree_conflict\b([^>]*)\/?>/.exec(String(text ?? ''));
  if (!match) return null;
  return {
    holder: attr(match[1], 'holder') ?? '',
    branch: attr(match[1], 'branch') ?? '',
    path: attr(match[1], 'path') ?? '',
  };
}

/** Who wrote a space message (`collaboration_space_messages.origin`). */
export type MessageOrigin = 'user' | 'agent';

export type StreamMessage = {
  /** Stable message id; what a later `in_reply_to` points at. */
  id?: string;
  seq: number;
  /** Backend sends `user|agent`; other values are client-side markers. */
  origin?: MessageOrigin | (string & {});
  /**
   * Id of the message this one replies to (cross-chat member-to-member
   * correlation). Always the bare id, comparable with `id`.
   */
  in_reply_to?: string | null;
  envelope: {
    actor?: string;
    content?: string;
    summary?: string;
    to?: string[];
    /** Raw envelope value (may be a `vibex://space-message/<id>` URI). */
    inReplyTo?: string | null;
  };
};

/**
 * The message `message` replies to, looked up by id among `messages`
 * (null when it is not a reply or the target is not loaded).
 */
export function replyTargetOf<T extends StreamMessage>(
  message: StreamMessage,
  messages: readonly T[]
): T | null {
  const target = message.in_reply_to;
  if (!target) return null;
  return messages.find((candidate) => candidate.id === target) ?? null;
}

/** A cross-DM system line shown in one member's direct chat. */
export type DirectChatNotice = CrossChatNotice & {
  key: string;
  /** Wall-clock time of the underlying space message, for interleaving. */
  at?: string | null;
};

/**
 * Cross-DM notice lines for `viewer`'s direct chat, from member-to-member
 * (`origin: 'agent'`) messages: the viewer messaging another member gives
 * `sent_to`; another member messaging (or replying to) the viewer gives
 * `received_from`. Direct chats only; group chats never call this.
 */
export function directChatNotices<
  T extends StreamMessage & { created_at?: string | null },
>(viewer: string, messages: readonly T[]): DirectChatNotice[] {
  if (!viewer) return [];
  const out: DirectChatNotice[] = [];
  for (const message of messages) {
    if (message.origin !== 'agent') continue;
    const author = actorName(message.envelope.actor);
    if (!author) continue;
    const id = message.id ?? String(message.seq);
    const targets = (message.envelope.to ?? [])
      .map((target) => actorName(target))
      .filter(Boolean);
    if (author === viewer) {
      for (const target of new Set(targets)) {
        if (target === viewer) continue;
        out.push({
          kind: 'sent_to',
          nickname: target,
          key: `${id}:sent_to:${target}`,
          at: message.created_at,
        });
      }
      continue;
    }
    const replyTarget = replyTargetOf(message, messages);
    const repliesToViewer =
      replyTarget != null && actorName(replyTarget.envelope.actor) === viewer;
    if (targets.includes(viewer) || repliesToViewer) {
      out.push({
        kind: 'received_from',
        nickname: author,
        key: `${id}:received_from:${author}`,
        at: message.created_at,
      });
    }
  }
  return out;
}

export type StreamSegment<T extends StreamMessage> =
  | { kind: 'message'; message: T }
  | { kind: 'agent-fold'; key: string; messages: T[]; pair: string };

function addressesUser(message: StreamMessage): boolean {
  return (message.envelope.to ?? []).some((target) =>
    String(target).endsWith('/user')
  );
}

function actorName(actor: string | undefined): string {
  const marker = '/member/';
  const raw = String(actor ?? '');
  const index = raw.lastIndexOf(marker);
  if (index < 0) return '';
  try {
    return decodeURIComponent(raw.slice(index + marker.length));
  } catch {
    return raw.slice(index + marker.length);
  }
}

/**
 * Collapse runs of agent-to-agent messages (origin = agent) into one fold.
 * Messages addressed to the user, or carrying a card or handoff, stay visible.
 */
export function segmentStream<T extends StreamMessage>(
  messages: readonly T[]
): StreamSegment<T>[] {
  const segments: StreamSegment<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const names = Array.from(
      new Set(run.map((m) => actorName(m.envelope.actor)).filter(Boolean))
    );
    segments.push({
      kind: 'agent-fold',
      key: `fold-${run[0].seq}`,
      messages: run,
      pair: names.slice(0, 2).join(' ↔ ') + (names.length > 2 ? ' …' : ''),
    });
    run = [];
  };
  for (const message of messages) {
    const content = message.envelope.content ?? '';
    const foldable =
      message.origin === 'agent' &&
      !addressesUser(message) &&
      !parseCard(content) &&
      !parseHandoff(content) &&
      !parseWorktreeConflict(content);
    if (foldable) {
      run.push(message);
      continue;
    }
    flush();
    segments.push({ kind: 'message', message });
  }
  flush();
  return segments;
}

export type ReceiptState =
  | 'queued'
  | 'waking'
  | 'processing'
  | 'replied'
  | 'limit_reached'
  | 'failed';

export type ReceiptInput = {
  conversation_id?: string;
  nickname?: string;
  state?: string;
  delivered?: string;
  error_code?: string | null;
};

export function receiptState(receipt: ReceiptInput): ReceiptState {
  if (receipt.delivered === 'failed' || receipt.error_code) return 'failed';
  switch (receipt.state) {
    case 'processing':
    case 'replied':
    case 'limit_reached':
    case 'waking':
      return receipt.state;
    default:
      return 'queued';
  }
}

export function receiptLabel(state: ReceiptState): string {
  switch (state) {
    case 'waking':
      return THREAD_COPY.receiptWaking;
    case 'processing':
      return THREAD_COPY.receiptProcessing;
    case 'replied':
      return THREAD_COPY.receiptReplied;
    case 'limit_reached':
      return THREAD_COPY.receiptLimit;
    case 'failed':
      return THREAD_COPY.receiptFailed;
    default:
      return THREAD_COPY.receiptQueued;
  }
}

/** Consequence of @-mentioning a member in a group, for the mention popover. */
export function mentionConsequence(presence: PresenceView): string {
  if (presence.state === 'busy' && presence.busyThreads[0]) {
    return THREAD_COPY.willQueue(presence.busyThreads[0]);
  }
  if (presence.state === 'sleeping') return THREAD_COPY.willWakeSleeping;
  return THREAD_COPY.willWake;
}

export type FactScopeTag = {
  kind: 'global' | 'thread' | 'private';
  label: string;
};

export function factScopeTag(
  scope: string,
  threadNames: ReadonlyMap<string, string> = new Map()
): FactScopeTag {
  if (scope === 'private') return { kind: 'private', label: '私聊·不共享' };
  if (scope.startsWith('thread:')) {
    const id = scope.slice('thread:'.length);
    return { kind: 'thread', label: `#${threadNames.get(id) ?? id}` };
  }
  return { kind: 'global', label: '全局' };
}

/** Count of pending ask/approval cards per member id. */
export function attentionByMember(
  cards: readonly { member_id?: string | null; status?: string }[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.status !== 'pending' || !card.member_id) continue;
    counts.set(card.member_id, (counts.get(card.member_id) ?? 0) + 1);
  }
  return counts;
}

/** Steps/tools/duration of an assistant turn for the collapsed process row. */
export function processSummary(turn: {
  blocks?: readonly { type?: string }[];
  duration_ms?: bigint | number | null;
}): { steps: number; tools: number; durationMs: number | null } {
  const blocks = turn.blocks ?? [];
  const steps = blocks.filter((block) => block.type !== 'text').length;
  const tools = blocks.filter((block) => block.type === 'tool_use').length;
  const duration = turn.duration_ms == null ? null : Number(turn.duration_ms);
  return { steps, tools, durationMs: duration };
}

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const MIGRATION_NOTICE_KEY = 'vibex-collaboration-migration-notice-seen';

export function migrationNoticeSeen(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): boolean {
  try {
    return storage?.getItem(MIGRATION_NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markMigrationNoticeSeen(
  storage: Pick<Storage, 'setItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): void {
  try {
    storage?.setItem(MIGRATION_NOTICE_KEY, '1');
  } catch {
    // Ignore quota errors.
  }
}

export type TeamTemplate = {
  id: string;
  name: string;
  description: string;
  members: { nickname: string; roleHint: string }[];
};

export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  {
    id: 'fullstack',
    name: '全栈小队',
    description: '前端、后端、测试各一位',
    members: [
      { nickname: '前端', roleHint: 'frontend' },
      { nickname: '后端', roleHint: 'backend' },
      { nickname: '测试', roleHint: 'qa' },
    ],
  },
  {
    id: 'bugfix',
    name: '修 Bug 二人组',
    description: '一位定位问题，一位复核修复',
    members: [
      { nickname: '排查', roleHint: 'debugger' },
      { nickname: '复核', roleHint: 'reviewer' },
    ],
  },
  {
    id: 'docs',
    name: '文档小组',
    description: '写作与校对',
    members: [
      { nickname: '撰写', roleHint: 'writer' },
      { nickname: '校对', roleHint: 'editor' },
    ],
  },
];
