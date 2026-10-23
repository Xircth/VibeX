export const COPY = {
  emptyRoles: '还没有角色',
  newRole: '新建角色',
  emptyTeams: '还没有团队',
  newTeam: '新建团队',
  emptySpaces: '还没有协作空间',
  newSpace: '新建空间',
  newSpaceButton: '新建协作空间',
  newMemberButton: '新建成员',
  newMemberFromSessionButton: '从会话新建成员',
  defaultSpaceName: '默认空间',
  unassignedSpaceName: '未定空间',
  noMemberSessions: '暂无成员会话',
  memberNameLabel: '成员名称',
  memberSourceLabel: '创建方式',
  memberSourceRole: '基于角色',
  memberSourceSession: '基于会话',
  memberSourceCustom: '自定义',
  chooseRole: '选择角色',
  chooseAgent: '选择 Agent',
  personaPromptLabel: '人设提示词（可选）',
  teamLabel: '归属团队（可选）',
  noTeam: '不属于任何团队',
  spaceMembersLabel: '协作空间成员（可选）',
  spaceTagLabel: '颜色标签',
  memberSessionsGroup: '可选成员',
  otherSessionsGroup: '非成员会话',
  addMember: '加入成员',
  renameMember: '修改昵称',
  chooseConversation: '选择会话',
  searchPlaceholder: '搜索协作空间或成员...',
  filterLabel: '筛选',
  filterByAgent: '按 Agent',
  filterByActiveTime: '按活跃时间',
  filterByMember: '按成员',
  filterAllAgents: '全部 Agent',
  filterAllTimes: '全部时间',
  filterTimeActiveNow: '当前活跃',
  filterTime24h: '最近 24 小时',
  filterTime7d: '最近 7 天',
  filterAllMembers: '全部成员',
  filterReset: '重置筛选',
  batchDeleteLabel: '批量删除',
  emptyMessages: '还没有消息',
  previewEmpty: '暂无成员会话',
  noSession: '没有会话',
  backToSession: '返回会话',
  attachmentsUnsupported: '空间消息只发送文字',
  deleteRole: '删除后，已创建的会话仍保留。',
  openWorkspace: '在工作区打开',
  you: '你',
  notAMember: '不在这个空间',
  nicknameMissing: '昵称不存在',
  nicknameTaken: '昵称已被使用',
  openWorkspaceFirst: '先打开一个工作区',
  emptyAgents: '还没有已启用的 Agent',
  controlsUnavailable: '暂不可用',
  noneDelivered: '没有送达',
  partialDelivered: '部分成员没有送达',
  receiptQueued: '已收到',
  receiptClaimed: '已收到',
  receiptFailed: '失败',
  requestFailed: '请求失败',
  rangeError: '深度 1–8，缓存不少于 0，查询窗口 1–90，延时上限 1–168。',
} as const;

export const VIRTUAL_DEFAULT_SPACE_ID = '__default_space__';

export function unassignedSpaceId(workspaceId: string): string {
  return `unassigned:${workspaceId}`;
}

export const ENGLISH_MEMBER_NAMES = [
  'Alex',
  'Blair',
  'Casey',
  'Devon',
  'Ellis',
  'Finley',
  'Gray',
  'Harper',
  'Indie',
  'Jordan',
  'Kai',
  'Logan',
  'Morgan',
  'Noel',
  'Parker',
  'Quinn',
  'Riley',
  'Sage',
  'Taylor',
  'Vale',
  'Wren',
] as const;

export function randomEnglishNickname(
  existingNames: Iterable<string> = [],
  seed?: number
): string {
  const taken = new Set(
    Array.from(existingNames)
      .map((name) => String(name ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const available = ENGLISH_MEMBER_NAMES.filter(
    (candidate) => !taken.has(candidate.toLowerCase())
  );
  if (available.length > 0) {
    const index =
      typeof seed === 'number' && Number.isFinite(seed)
        ? Math.abs(Math.floor(seed)) % available.length
        : Math.floor(Math.random() * available.length);
    return available[index] ?? available[0];
  }
  const base =
    ENGLISH_MEMBER_NAMES[
      typeof seed === 'number' && Number.isFinite(seed)
        ? Math.abs(Math.floor(seed)) % ENGLISH_MEMBER_NAMES.length
        : Math.floor(Math.random() * ENGLISH_MEMBER_NAMES.length)
    ] ?? 'Alex';
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36).slice(-3)}`;
}

export type SpaceTagPreset = {
  id: string;
  label: string;
  hue: string;
};

export const SPACE_TAG_PRESETS: readonly SpaceTagPreset[] = [
  { id: 'blue', label: '蓝色', hue: '214 88% 56%' },
  { id: 'emerald', label: '绿色', hue: '152 68% 42%' },
  { id: 'amber', label: '琥珀', hue: '38 92% 50%' },
  { id: 'violet', label: '紫色', hue: '262 76% 58%' },
  { id: 'rose', label: '玫红', hue: '346 78% 56%' },
  { id: 'cyan', label: '青色', hue: '192 82% 44%' },
] as const;

export type SpaceTagConfig = {
  colorId: string;
  label?: string;
};

const SPACE_TAGS_STORAGE_KEY = 'vibex-collaboration-space-tags';

export function readSpaceTags(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): Record<string, SpaceTagConfig> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SPACE_TAGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, SpaceTagConfig> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const colorId = String(record.colorId ?? '').trim();
        const label =
          typeof record.label === 'string' && record.label.trim()
            ? record.label.trim()
            : undefined;
        if (colorId) {
          result[key] = { colorId, ...(label ? { label } : {}) };
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeSpaceTags(
  tags: Record<string, SpaceTagConfig>,
  storage: Pick<Storage, 'setItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): void {
  if (!storage) return;
  try {
    storage.setItem(SPACE_TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch {
    // Ignore storage quota errors.
  }
}

export function sortConversationsForSpaceMemberPicker<
  T extends { conversation_id: string },
>(
  conversations: readonly T[],
  memberNicknameByConversationId: ReadonlyMap<string, string>
): {
  memberConversations: T[];
  nonMemberConversations: T[];
  sorted: T[];
} {
  const memberConversations: T[] = [];
  const nonMemberConversations: T[] = [];
  for (const item of conversations) {
    if (memberNicknameByConversationId.has(item.conversation_id)) {
      memberConversations.push(item);
    } else {
      nonMemberConversations.push(item);
    }
  }
  return {
    memberConversations,
    nonMemberConversations,
    sorted: [...memberConversations, ...nonMemberConversations],
  };
}

export function resolveMessageConversationId(
  envelope:
    | {
        actor?: string;
        attributedTo?: string;
      }
    | null
    | undefined,
  members: ReadonlyArray<SpaceMember> | null | undefined
): string {
  const attributed = String(envelope?.attributedTo ?? '').trim();
  const prefix = 'vibex://conversation/';
  if (attributed.toLowerCase().startsWith(prefix)) {
    const id = attributed.slice(prefix.length).trim();
    if (id) return id;
  }
  const author = messageAuthor(envelope);
  if (!author || author === COPY.you) return '';
  const matched = agentRoster(members ? [...members] : []).find(
    (member) => String(member.nickname ?? '').trim() === author
  );
  return String(matched?.conversation_id ?? '').trim();
}

export type SpaceMember = {
  nickname?: string;
  kind?: string;
  visible_to_agents?: number;
  conversation_id?: string | null;
  member_id?: string;
};

export type DeliveryReceipt = {
  conversation_id?: string;
  nickname?: string;
  delivered?: string;
  input_id?: string | null;
  error_code?: string | null;
};

export type CollaborationSpaceChangedPayload = {
  workspaceId: string;
  spaceId: string;
  seq?: number;
  memberId?: string;
};

const MENTION_TAIL = /(?:^|\s)@([^\s@]*)$/;
const MENTION_TOKEN = /(?:^|\s)@([^\s@]+)/g;

export function displayName(member: SpaceMember | null | undefined): string {
  if (!member || member.kind === 'user') return COPY.you;
  return String(member.nickname ?? '');
}

export function agentRoster(
  members: SpaceMember[] | null | undefined
): SpaceMember[] {
  return (Array.isArray(members) ? members : []).filter(
    (member) =>
      member &&
      member.kind === 'agent' &&
      Number(member.visible_to_agents) !== 0
  );
}

export function mentionQuery(text: string | null | undefined): string | null {
  const match = MENTION_TAIL.exec(String(text ?? ''));
  return match ? match[1] : null;
}

export function mentionSuggestions(
  text: string | null | undefined,
  members: SpaceMember[] | null | undefined
): SpaceMember[] {
  const query = mentionQuery(text);
  if (query == null) return [];
  return agentRoster(members).filter((member) =>
    String(member.nickname ?? '').startsWith(query)
  );
}

export function mentionNicknames(
  text: string | null | undefined,
  members: SpaceMember[] | null | undefined
): string[] {
  const names = new Set(
    agentRoster(members)
      .map((member) => String(member.nickname ?? ''))
      .filter(Boolean)
  );
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text ?? '').matchAll(MENTION_TOKEN)) {
    const token = match[1];
    if (!names.has(token) || seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

export function deliveryFailureCopy(
  receipts: DeliveryReceipt[] | null | undefined
): string {
  if (!Array.isArray(receipts) || receipts.length === 0) return '';
  const failed = receipts.filter(
    (receipt) =>
      receipt &&
      (receipt.delivered === 'failed' ||
        (typeof receipt.error_code === 'string' && receipt.error_code))
  );
  if (failed.length === 0) return '';
  return failed.length === receipts.length
    ? COPY.noneDelivered
    : COPY.partialDelivered;
}

export function receiptStatusCopy(
  receipt: DeliveryReceipt | null | undefined,
  labels: {
    queued?: string;
    claimed?: string;
    failed?: string;
  } = {}
): string {
  const delivered = String(receipt?.delivered ?? '');
  const hasError =
    delivered === 'failed' ||
    (typeof receipt?.error_code === 'string' && Boolean(receipt.error_code));
  if (hasError) return labels.failed ?? COPY.receiptFailed;
  if (
    delivered === 'dispatched' ||
    delivered === 'claimed' ||
    delivered === 'started'
  ) {
    return labels.claimed ?? COPY.receiptClaimed;
  }
  return labels.queued ?? COPY.receiptQueued;
}

export function resolveMessageReceipts(
  envelope:
    | {
        to?: readonly string[] | null;
      }
    | null
    | undefined,
  explicitReceipts: ReadonlyArray<DeliveryReceipt> | null | undefined
): DeliveryReceipt[] {
  if (Array.isArray(explicitReceipts) && explicitReceipts.length > 0) {
    return [...explicitReceipts];
  }
  const toList = Array.isArray(envelope?.to) ? envelope.to : [];
  if (toList.length === 0) return [];
  const marker = '/member/';
  const derived: DeliveryReceipt[] = [];
  const seen = new Set<string>();
  for (const item of toList) {
    const raw = String(item ?? '').trim();
    const index = raw.lastIndexOf(marker);
    if (index < 0) continue;
    let nickname = raw.slice(index + marker.length);
    try {
      nickname = decodeURIComponent(nickname);
    } catch {
      // Keep raw segment if decode fails
    }
    nickname = nickname.trim();
    if (!nickname || seen.has(nickname)) continue;
    seen.add(nickname);
    derived.push({
      nickname,
      delivered: 'claimed',
    });
  }
  return derived;
}

export function postRecipients(
  text: string | null | undefined,
  members: SpaceMember[] | null | undefined
): string[] {
  return mentionNicknames(text, members);
}

export function strayMentions(
  text: string | null | undefined,
  members: SpaceMember[] | null | undefined
): string[] {
  const known = new Set(
    agentRoster(members).map((member) => String(member.nickname ?? ''))
  );
  return [...String(text ?? '').matchAll(MENTION_TOKEN)]
    .map((match) => match[1])
    .filter((token) => token && !known.has(token));
}

export function userSendIsBroadcast(
  text: string | null | undefined,
  members: SpaceMember[] | null | undefined
): boolean {
  return (
    strayMentions(text, members).length === 0 &&
    postRecipients(text, members).length === 0
  );
}

export function insertMention(
  text: string | null | undefined,
  nickname: string
): string {
  const source = String(text ?? '');
  if (mentionQuery(source) == null) return `${source}@${nickname} `;
  return source.replace(/@[^\s@]*$/, `@${nickname} `);
}

export function messageAuthor(
  envelope:
    | {
        actor?: string;
      }
    | null
    | undefined
): string {
  const actor = String(envelope?.actor ?? '');
  if (actor.endsWith('/user')) return COPY.you;
  const marker = '/member/';
  const index = actor.lastIndexOf(marker);
  if (index >= 0) {
    try {
      return decodeURIComponent(actor.slice(index + marker.length));
    } catch {
      return actor.slice(index + marker.length);
    }
  }
  return '';
}

export function sendErrorCopy(code: string): string {
  if (code === 'not_a_member') return COPY.notAMember;
  if (code === 'nickname_taken') return COPY.nicknameTaken;
  if (code === 'not_found') return COPY.nicknameMissing;
  return '';
}

export function surfaceErrorCopy(cause: unknown): string {
  const record =
    cause && typeof cause === 'object'
      ? (cause as { code?: unknown; message?: unknown })
      : null;
  const code = record?.code != null ? String(record.code) : '';
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : record?.message != null
          ? String(record.message)
          : '';
  const known = sendErrorCopy(code) || sendErrorCopy(message);
  if (known) return known;
  if (
    code === 'capability_unimplemented' ||
    message.includes('is not exposed by the Host capability broker') ||
    message.includes('capability_unimplemented')
  ) {
    return COPY.controlsUnavailable;
  }
  return message || COPY.requestFailed;
}

export function integerInRange(
  value: unknown,
  min: number,
  max: number
): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export function parseSpaceChangedEvent(
  payload: unknown
): CollaborationSpaceChangedPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const workspaceId = String(
    record.workspaceId ?? record.workspace_id ?? ''
  ).trim();
  const spaceId = String(record.spaceId ?? record.space_id ?? '').trim();
  if (!workspaceId || !spaceId) return null;
  const rawSeq = record.seq;
  const seq =
    typeof rawSeq === 'number' && Number.isInteger(rawSeq) ? rawSeq : undefined;
  const rawMemberId = record.memberId ?? record.member_id;
  const memberId =
    typeof rawMemberId === 'string' && rawMemberId.trim()
      ? rawMemberId.trim()
      : undefined;
  if (seq === undefined && memberId === undefined) return null;
  return {
    workspaceId,
    spaceId,
    ...(seq !== undefined ? { seq } : {}),
    ...(memberId !== undefined ? { memberId } : {}),
  };
}

export function latestMessageSeq(
  messages: ReadonlyArray<{ seq: number }> | null | undefined
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let max = 0;
  for (const item of messages) {
    if (item && Number.isInteger(item.seq) && item.seq > max) {
      max = item.seq;
    }
  }
  return max;
}

export function mergeSpaceMessages<T extends { seq: number }>(
  existing: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>
): T[] {
  const bySeq = new Map<number, T>();
  for (const message of existing) {
    if (message && Number.isInteger(message.seq)) {
      bySeq.set(message.seq, message);
    }
  }
  for (const message of incoming) {
    if (message && Number.isInteger(message.seq)) {
      bySeq.set(message.seq, message);
    }
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export type ActiveTimeFilterWindow = 'all' | 'active' | '24h' | '7d';

export type SpaceFilterState = {
  searchQuery: string;
  agentId: string;
  activeWindow: ActiveTimeFilterWindow;
  memberConversationId: string;
};

export type FilterableConversationInfo = {
  conversation_id: string;
  title?: string | null;
  agent_id?: string | null;
  status?: string | null;
  has_active_attempt?: boolean;
  updated_at?: string | null;
};

export function isConversationActiveNow(
  info: FilterableConversationInfo | null | undefined
): boolean {
  if (!info) return false;
  const status = String(info.status ?? '').toLowerCase();
  return (
    Boolean(info.has_active_attempt) ||
    status === 'running' ||
    status === 'starting' ||
    status === 'queued'
  );
}

export function isWithinActiveWindow(
  window: ActiveTimeFilterWindow,
  isActiveNow: boolean,
  updatedAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (window === 'all') return true;
  if (window === 'active') return isActiveNow;
  if (isActiveNow) return true;
  if (!updatedAt) return false;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return false;
  const maxAgeMs =
    window === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return nowMs - parsed <= maxAgeMs;
}

export function memberSelectionKey(
  spaceId: string,
  conversationId: string
): string {
  return `${spaceId}::${conversationId}`;
}

export function parseMemberSelectionKey(key: string): {
  spaceId: string;
  conversationId: string;
} | null {
  const index = key.indexOf('::');
  if (index <= 0) return null;
  const spaceId = key.slice(0, index).trim();
  const conversationId = key.slice(index + 2).trim();
  if (!spaceId || !conversationId) return null;
  return { spaceId, conversationId };
}

export function toggleSpaceDeleteSelection(
  spaceId: string,
  members: ReadonlyArray<SpaceMember>,
  selectedSpaceIds: ReadonlySet<string>,
  selectedMemberKeys: ReadonlySet<string>
): {
  selectedSpaceIds: Set<string>;
  selectedMemberKeys: Set<string>;
} {
  const nextSpaces = new Set(selectedSpaceIds);
  const nextMembers = new Set(selectedMemberKeys);
  const willSelect = !nextSpaces.has(spaceId);
  if (willSelect) {
    nextSpaces.add(spaceId);
    for (const member of agentRoster([...members])) {
      const convId = String(member.conversation_id ?? '').trim();
      if (convId) {
        nextMembers.add(memberSelectionKey(spaceId, convId));
      }
    }
  } else {
    nextSpaces.delete(spaceId);
    for (const member of agentRoster([...members])) {
      const convId = String(member.conversation_id ?? '').trim();
      if (convId) {
        nextMembers.delete(memberSelectionKey(spaceId, convId));
      }
    }
  }
  return {
    selectedSpaceIds: nextSpaces,
    selectedMemberKeys: nextMembers,
  };
}

export function toggleMemberDeleteSelection(
  spaceId: string,
  conversationId: string,
  selectedMemberKeys: ReadonlySet<string>
): Set<string> {
  const nextMembers = new Set(selectedMemberKeys);
  const key = memberSelectionKey(spaceId, conversationId);
  if (nextMembers.has(key)) {
    nextMembers.delete(key);
  } else {
    nextMembers.add(key);
  }
  return nextMembers;
}

