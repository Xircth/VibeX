import { describe, expect, it } from 'vitest';

import {
  COPY,
  agentRoster,
  deliveryFailureCopy,
  displayName,
  insertMention,
  isCollaborationLimitNotice,
  latestMessageSeq,
  mentionSuggestions,
  mergeSpaceMessages,
  messageAuthor,
  resolveMessageReceipts,
  collectionDirFromHostPayload,
  displayPersonLabel,
  isBotSpaceKind,
  isGroupSpaceKind,
  isHumanPersonLabel,
  isPrivateChatKind,
  parseSpaceChangedEvent,
  spaceKindId,
  postRecipients,
  randomEnglishNickname,
  readSpaceTags,
  receiptStatusCopy,
  resolveMessageConversationId,
  resolveMessageDeliveryStatus,
  sendErrorCopy,
  sortConversationsForSpaceMemberPicker,
  sortMembersLeadFirst,
  strayMentions,
  surfaceErrorCopy,
  toggleMemberDeleteSelection,
  toggleSpaceDeleteSelection,
  unassignedSpaceId,
  userSendIsBroadcast,
  writeSpaceTags,
  isWithinActiveWindow,
  parseMemberSelectionKey,
  type SpaceMember,
  buildChatList,
  defaultGroupChatNameFromMembers,
  formatRoundProgress,
  formatWorkingMembersCopy,
  isMemberWorking,
  indexIdentityMemberIdsByConversation,
  mergeDirectSpaceMessages,
  resolvePrivateChatTarget,
  uniqueBotsForGroupMemberPicker,
  buildCollabDmBootstrapPrompt,
  isCollabDmBootstrapPrompt,
  stripCollabDmBootstrapTags,
  contactLastMessagePreview,
  COLLAB_DM_BOOTSTRAP_PREFIX,
  COLLAB_DM_BOOTSTRAP_SUFFIX,
  DEFAULT_MASTER_BOT_NAME,
  DEFAULT_MASTER_BOT_PERSONA_PROMPT,
  extractEnvelopeCrossChatMeta,
} from './spaceModel';

const members: SpaceMember[] = [
  {
    nickname: '小A',
    kind: 'agent',
    visible_to_agents: 1,
    conversation_id: 'a',
  },
  {
    nickname: '小B',
    kind: 'agent',
    visible_to_agents: 1,
    conversation_id: 'b',
  },
  {
    nickname: '小AB',
    kind: 'agent',
    visible_to_agents: 1,
    conversation_id: 'ab',
  },
  {
    nickname: '你',
    kind: 'user',
    visible_to_agents: 0,
    conversation_id: null,
  },
  {
    nickname: '隐藏',
    kind: 'agent',
    visible_to_agents: 0,
    conversation_id: 'h',
  },
];

describe('collaboration space model', () => {
  it('keeps the empty copy', () => {
    expect(COPY.emptyRoles).toBe('还没有角色');
    expect(COPY.newRole).toBe('新建角色');
    expect(COPY.emptySpaces).toBe('还没有协作空间');
    expect(COPY.newSpace).toBe('创建群聊');
    expect(COPY.newSpaceButton).toBe('创建群聊');
    expect(COPY.createMenu).toBe('创建');
    expect(COPY.spaceName).toBe('群聊名称');
    expect(COPY.spaceMembersLabel).toBe('群聊成员');
    expect(COPY.newMemberButton).toBe('新建助手');
    expect(COPY.createAssistantButton).toBe('创建助手');
    expect(COPY.createContactGroupButton).toBe('新建分组');
    expect(COPY.defaultContactGroupName).toBe('新分组');
    expect(COPY.workingNow).toBe('正在工作...');
    expect(COPY.workingNowPhrases).toEqual([
      '正在工作...',
      '正在深度求索...',
      '正在一点点推进...',
      '正在仔细推敲...',
      '正在埋头赶工...',
      '正在理清头绪...',
    ]);
    expect(COPY.groupDetailsButton).toBe('群组详情');
    expect(COPY.groupDetailsTab).toBe('详情');
    expect(COPY.groupCollectionTab).toBe('资产');
    expect(COPY.groupMembersTab).toBe('成员');
    expect(COPY.spaceTagLabel).toBe('颜色标签');
    expect(COPY.spaceTagNone).toBe('无标签');
    expect(COPY.spaceTagClear).toBe('取消标签');
    expect(COPY.spaceLeadLabel).toBe('负责人');
    expect(COPY.spaceLeadSet).toBe('设为负责人');
    expect(COPY.collaborationLimitNotice).toBe(
      '已达到自动协作上限，请 @ 助手继续'
    );
    expect(COPY.receiptPassed).toBe('已跳过');
    expect(COPY.receiptTimedOut).toBe('未回应');
    expect(COPY.receiptCancelled).toBe('已取消');
    expect(COPY.receiptReplied).toBe('已回复');
    expect(COPY.assistantDetailsButton).toBe('助手详情');
    expect(COPY.assistantDetailsTab).toBe('详情');
    expect(COPY.assistantCollectionTab).toBe('资产');
    expect(COPY.assistantCustomizeTab).toBe('自定义');
    expect(COPY.personaPromptLabel).toBe('人设（可选）');
    expect(COPY.addSpaceMember).toBe('添加成员');
    expect(COPY.removeSpaceMember).toBe('移除');
    expect(COPY.globalSearchPlaceholder).toBe('搜索');
    expect(COPY.filterByName).toBe('按名称');
    expect(COPY.filterByType).toBe('按类型');
    expect(COPY.filterTypeGroup).toBe('群聊');
    expect(COPY.filterTypeAssistant).toBe('助手');
    expect(COPY.filterByActiveTime).toBe('按活跃时间');
    expect(COPY.newMemberFromSessionButton).toBe('从会话新建助手');
    expect(COPY.defaultSpaceName).toBe('默认空间');
    expect(COPY.unassignedSpaceName).toBe('未定空间');
    expect(COPY.noMemberSessions).toBe('暂无助手会话');
    expect(COPY.emptyMessages).toBe('还没有消息');
    expect(COPY.deleteRole).toBe('删除后，已创建的会话仍保留。');
  });

  it('shows 你 for the user and hides them from the roster', () => {
    expect(displayName(members.find((member) => member.kind === 'user'))).toBe(
      '你'
    );
    expect(displayName({ kind: 'user', nickname: '你-2' })).toBe('你');
    expect(agentRoster(members).map((member) => member.nickname)).toEqual([
      '小A',
      '小B',
      '小AB',
    ]);
    expect(
      mentionSuggestions('@小', members).map((member) => member.nickname)
    ).toEqual(['小A', '小B', '小AB']);
    expect(mentionSuggestions('@你', members)).toEqual([]);
  });

  it('broadcasts a user message that has no mention', () => {
    expect(userSendIsBroadcast('我看一下 auth.ts', members)).toBe(true);
    expect(postRecipients('我看一下 auth.ts', members)).toEqual([]);
    expect(postRecipients('请 @小B @小C 看 diff', members)).toEqual(['小B']);
    expect(postRecipients('@小AB', members)).toEqual(['小AB']);
    expect(postRecipients('@小A', members)).toEqual(['小A']);
    expect(postRecipients('请 @小A @小AB', members)).toEqual(['小A', '小AB']);
    expect(userSendIsBroadcast('@小B 补充一句', members)).toBe(false);
    expect(strayMentions('@不存在 看一下', members)).toEqual(['不存在']);
    expect(
      strayMentions('看下 `@不存在` 和 ```ts\n@不存在\n```', members)
    ).toEqual([]);
    expect(strayMentions('@Person @User @你 看下', members)).toEqual([]);
    expect(userSendIsBroadcast('@不存在', members)).toBe(false);
  });

  it('inserts mentions and maps delivery copy', () => {
    expect(insertMention('请 @小', '小B')).toBe('请 @小B ');
    expect(messageAuthor({ sender: 'Person' })).toBe('你');
    expect(messageAuthor({ sender: 'User' })).toBe('你');
    expect(messageAuthor({ sender: '你' })).toBe('你');
    expect(messageAuthor({ sender: '小B' })).toBe('小B');
    expect(messageAuthor({ sender: 'system' })).toBe('');
    expect(isCollaborationLimitNotice({ envelope: { sender: 'system' } })).toBe(
      true
    );
    expect(resolveMessageReceipts({ to: ['Person', '小A'] }, null)).toEqual([
      { nickname: '小A', delivered: 'claimed' },
    ]);
    expect(
      resolveMessageReceipts(
        {
          to: ['User', '小B', '@小B'],
        },
        null
      )
    ).toEqual([{ nickname: '小B', delivered: 'claimed' }]);
    expect(isHumanPersonLabel('Person')).toBe(true);
    expect(isHumanPersonLabel('User')).toBe(true);
    expect(displayPersonLabel('Person')).toBe('你');
    expect(collectionDirFromHostPayload({ collectionDir: 'C:/spaces/a' })).toBe(
      'C:/spaces/a'
    );
    expect(
      collectionDirFromHostPayload({ collection_dir: 'C:/spaces/b' })
    ).toBe('C:/spaces/b');
    expect(
      isCollaborationLimitNotice({
        origin: 'system',
        envelope: { summary: 'collaboration_limit' },
      })
    ).toBe(true);
    expect(
      isCollaborationLimitNotice({
        origin: 'agent',
        envelope: { sender: '小B' },
      })
    ).toBe(false);
    expect(sendErrorCopy('not_a_member')).toBe('不在这个空间');
    expect(sendErrorCopy('not_found')).toBe('昵称不存在');
    expect(COPY.emptyAgents).toBe('还没有已启用的 Agent');
    expect(COPY.controlsUnavailable).toBe('暂不可用');
    expect(
      deliveryFailureCopy([{ delivered: 'failed' }, { delivered: 'failed' }])
    ).toBe('没有送达');
    expect(
      deliveryFailureCopy([
        { delivered: 'queued' },
        { delivered: 'failed', error_code: 'not_found' },
      ])
    ).toBe('部分助手没有送达');
    expect(deliveryFailureCopy([{ delivered: 'queued' }])).toBe('');
    expect(receiptStatusCopy({ delivered: 'queued' })).toBe('已收到');
    expect(receiptStatusCopy({ delivered: 'dispatched' })).toBe('已收到');
    expect(receiptStatusCopy({ delivered: 'claimed' })).toBe('已收到');
    expect(receiptStatusCopy({ delivered: 'failed' })).toBe('失败');
  });

  it('maps broker gaps and envelope messages to short copy', () => {
    expect(
      surfaceErrorCopy(
        new Error(
          'collaboration.space.list is not exposed by the Host capability broker'
        )
      )
    ).toBe(COPY.controlsUnavailable);
    expect(
      surfaceErrorCopy({ code: 'capability_unimplemented', message: 'missing' })
    ).toBe(COPY.controlsUnavailable);
    expect(
      surfaceErrorCopy({ code: 'not_found', message: 'missing nickname' })
    ).toBe(COPY.nicknameMissing);
    expect(
      surfaceErrorCopy({ code: 'bad_request', message: 'nickname_taken' })
    ).toBe(COPY.nicknameTaken);
    expect(surfaceErrorCopy(new Error('先打开一个工作区'))).toBe(
      '先打开一个工作区'
    );
  });

  it('parses space change events and merges incremental messages by seq', () => {
    expect(
      parseSpaceChangedEvent({
        workspaceId: 'ws-1',
        spaceId: 's-1',
        seq: 4,
      })
    ).toEqual({
      workspaceId: 'ws-1',
      spaceId: 's-1',
      seq: 4,
    });
    expect(
      parseSpaceChangedEvent({
        workspace_id: 'ws-1',
        space_id: 's-1',
        member_id: 'm-1',
      })
    ).toEqual({
      workspaceId: 'ws-1',
      spaceId: 's-1',
      memberId: 'm-1',
    });
    expect(
      parseSpaceChangedEvent({ workspaceId: 'ws-1', spaceId: 's-1' })
    ).toBeNull();
    expect(latestMessageSeq([{ seq: 1 }, { seq: 3 }, { seq: 2 }])).toBe(3);
    expect(latestMessageSeq([])).toBe(0);
    expect(
      mergeSpaceMessages(
        [
          { seq: 1, text: 'a' },
          { seq: 2, text: 'b' },
        ],
        [
          { seq: 2, text: 'b-updated' },
          { seq: 3, text: 'c' },
        ]
      )
    ).toEqual([
      { seq: 1, text: 'a' },
      { seq: 2, text: 'b-updated' },
      { seq: 3, text: 'c' },
    ]);
  });

  it('sorts member conversations first, generates unique English nicknames, and resolves message conversation ids', () => {
    expect(unassignedSpaceId('ws-1')).toBe('unassigned:ws-1');
    const firstNick = randomEnglishNickname([], 0);
    const secondNick = randomEnglishNickname([firstNick], 0);
    expect(firstNick).toBe('Alex');
    expect(secondNick).toBe('Blair');

    const sorted = sortConversationsForSpaceMemberPicker(
      [
        { conversation_id: 'c-non-1', title: '普通会话1' },
        { conversation_id: 'c-mem-1', title: '成员会话1' },
        { conversation_id: 'c-non-2', title: '普通会话2' },
      ],
      new Map([['c-mem-1', '小A']])
    );
    expect(sorted.memberConversations.map((c) => c.conversation_id)).toEqual([
      'c-mem-1',
    ]);
    expect(sorted.nonMemberConversations.map((c) => c.conversation_id)).toEqual(
      ['c-non-1', 'c-non-2']
    );
    expect(sorted.sorted.map((c) => c.conversation_id)).toEqual([
      'c-mem-1',
      'c-non-1',
      'c-non-2',
    ]);

    expect(
      resolveMessageConversationId(
        {
          sender: '小A',
          conversation_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
        members
      )
    ).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(
      resolveMessageConversationId(
        {
          sender: '小B',
        },
        members
      )
    ).toBe('b');
    expect(resolveMessageConversationId({ sender: '小A' }, members)).toBe('a');

    const memoryStorage = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memoryStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memoryStorage.set(key, value);
      },
    };
    writeSpaceTags({ s1: { colorId: 'blue', label: '核心' } }, storage);
    expect(readSpaceTags(storage)).toEqual({
      s1: { colorId: 'blue', label: '核心' },
    });
  });

  it('selects all space members when selecting a space for batch delete and allows deselecting individual members', () => {
    const first = toggleSpaceDeleteSelection(
      's1',
      members,
      new Set(),
      new Set()
    );
    expect([...first.selectedSpaceIds]).toEqual(['s1']);
    expect([...first.selectedMemberKeys]).toEqual(['s1::a', 's1::b', 's1::ab']);

    // Deselect member 'a' while keeping space 's1' selected
    const afterDeselectOne = toggleMemberDeleteSelection(
      's1',
      'a',
      first.selectedMemberKeys
    );
    expect([...first.selectedSpaceIds]).toEqual(['s1']);
    expect([...afterDeselectOne]).toEqual(['s1::b', 's1::ab']);
    expect(parseMemberSelectionKey('s1::b')).toEqual({
      spaceId: 's1',
      conversationId: 'b',
    });

    // Deselecting space 's1' clears its remaining member selections
    const cleared = toggleSpaceDeleteSelection(
      's1',
      members,
      first.selectedSpaceIds,
      afterDeselectOne
    );
    expect([...cleared.selectedSpaceIds]).toEqual([]);
    expect([...cleared.selectedMemberKeys]).toEqual([]);

    const now = Date.parse('2026-10-21T10:00:00Z');
    expect(
      isWithinActiveWindow('active', true, '2026-10-01T00:00:00Z', now)
    ).toBe(true);
    expect(
      isWithinActiveWindow('active', false, '2026-10-21T09:59:00Z', now)
    ).toBe(false);
    expect(
      isWithinActiveWindow('24h', false, '2026-10-20T12:00:00Z', now)
    ).toBe(true);
    expect(
      isWithinActiveWindow('24h', false, '2026-10-18T12:00:00Z', now)
    ).toBe(false);
  });
});

describe('buildChatList', () => {
  const agent = (id: string, nickname: string) => ({
    member_id: id,
    nickname,
    kind: 'agent',
    visible_to_agents: 1,
    conversation_id: `conv-${id}`,
  });
  const user = {
    member_id: 'u',
    nickname: '你',
    kind: 'user',
    visible_to_agents: 0,
  };

  it('flattens groups and private chats; one-agent spaces are private', () => {
    const list = buildChatList({
      spaces: [
        { space_id: 's1', name: '设计' },
        { space_id: 's2', name: '单聊空间' },
      ],
      membersBySpace: {
        s1: [agent('a', '小A'), agent('b', '小B'), user],
        s2: [agent('c', '小C'), user],
      },
      unassignedSpaceId: 'unassigned:w',
      unassignedMembers: [agent('d', '小D'), user],
    });
    expect(list.map((e) => [e.type, e.name])).toEqual([
      ['group', '设计'],
      ['direct', '小C'],
      ['direct', '小D'],
    ]);
    const group = list[0];
    expect(
      group.type === 'group' && group.members.map((m) => m.nickname)
    ).toEqual(['小A', '小B']);
  });

  it('prefers an explicit space kind over the member-count heuristic', () => {
    const list = buildChatList({
      spaces: [
        { space_id: 'g1', name: '单人群', kind: 'group' },
        { space_id: 'd1', name: 'dm', kind: 'dm' },
        { space_id: 'd2', name: 'direct', kind: 'direct' },
      ],
      membersBySpace: {
        g1: [agent('a', '小A'), user],
        d1: [agent('b', '小B'), user],
        d2: [agent('c', '小C'), user],
      },
    });
    expect(list.map((e) => [e.type, e.name])).toEqual([
      ['group', '单人群'],
      ['direct', '小B'],
      ['direct', '小C'],
    ]);
  });

  it('treats person2bot as BotSpace and person2group as GroupSpace', () => {
    expect(isBotSpaceKind('person2bot')).toBe(true);
    expect(isBotSpaceKind('BotSpace')).toBe(true);
    expect(isPrivateChatKind('person2bot')).toBe(true);
    expect(isGroupSpaceKind('person2group')).toBe(true);
    expect(spaceKindId('person2bot')).toBe('person2bot');
    expect(spaceKindId('group')).toBe('person2group');
    expect(spaceKindId(undefined, 'direct:mem-a')).toBe('person2bot');
    const list = buildChatList({
      spaces: [
        { space_id: 'direct:mem-b', name: '小B', kind: 'person2bot' },
        { space_id: 'g-research', name: '调研', kind: 'person2group' },
      ],
      membersBySpace: {
        'direct:mem-b': [agent('b', '小B'), user],
        'g-research': [agent('a', '小A'), agent('c', '小C'), user],
      },
    });
    expect(list.map((e) => [e.type, e.name])).toEqual([
      ['direct', '小B'],
      ['group', '调研'],
    ]);
  });
});

describe('resolvePrivateChatTarget', () => {
  const chatList = buildChatList({
    spaces: [],
    membersBySpace: {},
    unassignedSpaceId: 'unassigned:w',
    unassignedMembers: [
      {
        member_id: 'm1',
        nickname: '小新',
        kind: 'agent',
        conversation_id: 'c1',
      },
    ],
  });

  it('uses direct_thread_id / identity_member_id returned by creation first', () => {
    const sidebarList = buildChatList({
      sidebarItems: [
        {
          kind: 'dm',
          thread_id: 'direct:im-7',
          space_id: 'unassigned:w',
          member: { member_id: 'im-7', name: '小新', conversation_id: 'c7' },
        },
      ],
      spaces: [],
      membersBySpace: {},
    });
    const target = resolvePrivateChatTarget({
      created: {
        identity_member_id: 'im-7',
        direct_thread_id: 'direct:im-7',
        conversation_id: 'c7',
      },
      fallbackNickname: '小新',
      directSpaceId: 'x',
      chatList: sidebarList,
    });
    expect(target).toMatchObject({
      spaceId: 'direct:im-7',
      threadId: 'direct:im-7',
      member: { member_id: 'im-7' },
    });
  });

  it('derives the direct thread from identity_member_id when not listed yet', () => {
    const target = resolvePrivateChatTarget({
      created: { identity_member_id: 'im-8' },
      fallbackNickname: '小新',
      directSpaceId: 'unassigned:w',
      chatList: [],
    });
    expect(target).toMatchObject({
      spaceId: 'direct:im-8',
      threadId: 'direct:im-8',
      member: { member_id: 'im-8', nickname: '小新' },
    });
  });

  it('falls back to the member 1:1 chat in the list', () => {
    const target = resolvePrivateChatTarget({
      created: { private_conversation_id: 'c1' },
      fallbackNickname: '小新',
      directSpaceId: 'x',
      chatList,
    });
    expect(target.spaceId).toBe('direct:m1');
    expect(target.member.member_id).toBe('m1');
  });

  it('falls back to the direct space when nothing matches', () => {
    const target = resolvePrivateChatTarget({
      created: null,
      fallbackNickname: '小新',
      directSpaceId: 'unassigned:w',
      chatList: [],
    });
    expect(target).toMatchObject({
      spaceId: 'unassigned:w',
      member: { nickname: '小新' },
    });
  });
});

describe('chatListFromSidebar (thread.listSidebar adapter)', () => {
  const items = [
    {
      kind: 'group',
      thread_id: 'sp-1',
      space_id: 'sp-1',
      name: '设计',
      tag_color: 'blue',
      last_message: { id: 9, seq: 9, preview: '好的', origin: 'agent' },
      last_activity_at: '2026-10-24T10:00:00Z',
      unread_count: 3,
      members_preview: [
        { member_id: 'm1', name: '小A', conversation_id: 'c1' },
        { member_id: 'm2', name: '小B', conversation_id: 'c2' },
      ],
      member_count: 6,
    },
    {
      kind: 'dm',
      thread_id: 'direct:m1',
      space_id: 'unassigned:w',
      name: '小A',
      tag_color: null,
      last_message: null,
      last_activity_at: null,
      unread_count: 0,
      member: { member_id: 'm1', name: '小A', conversation_id: 'c1' },
    },
  ];

  it('prefers sidebar items and keeps their order', () => {
    const list = buildChatList({
      sidebarItems: items,
      spaces: [{ space_id: 'ignored', name: '忽略' }],
      membersBySpace: {},
      unassignedSpaceId: 'unassigned:w',
    });
    expect(list.map((e) => [e.type, e.name, e.spaceId, e.threadId])).toEqual([
      ['group', '设计', 'sp-1', 'sp-1'],
      ['direct', '小A', 'unassigned:w', 'direct:m1'],
    ]);
    const [group, dm] = list;
    expect(group).toMatchObject({
      tagColor: 'blue',
      lastPreview: '好的',
      unreadCount: 3,
      memberCount: 6,
    });
    expect(
      group.type === 'group' && group.members.map((m) => m.nickname)
    ).toEqual(['小A', '小B']);
    // DMs usually have no last message / unread: nothing to render.
    expect(dm.lastPreview).toBeUndefined();
    expect(dm.unreadCount).toBeUndefined();
    expect(dm.type === 'direct' && dm.member).toMatchObject({
      member_id: 'm1',
      conversation_id: 'c1',
    });
  });

  it('falls back to local derivation when sidebar items are null', () => {
    const list = buildChatList({
      sidebarItems: null,
      spaces: [{ space_id: 's1', name: '设计' }],
      membersBySpace: {},
    });
    expect(list.map((e) => e.type)).toEqual(['group']);
  });
});

describe('private chat helpers', () => {
  it('derives the direct thread id', async () => {
    const { directThreadIdFor } = await import('./spaceModel');
    expect(directThreadIdFor({ member_id: 'm1' })).toBe('direct:m1');
    expect(directThreadIdFor({ member_id: 'm1' }, 'direct:x')).toBe('direct:x');
    expect(directThreadIdFor({}, 'space-1')).toBeNull();
  });

  it('reconciles pending DM messages by operationId or content', async () => {
    const { reconcilePendingDirectMessages } = await import('./spaceModel');
    const pending = [
      { operationId: 'a', threadId: 'direct:m', content: 'one', createdAt: 1 },
      { operationId: 'b', threadId: 'direct:m', content: 'two', createdAt: 2 },
      { operationId: 'c', threadId: 'direct:m', content: 'two', createdAt: 3 },
      { operationId: 'd', threadId: 'direct:m', content: 'four', createdAt: 4 },
    ];
    const left = reconcilePendingDirectMessages(pending, [
      { seq: 1, operationId: 'a', envelope: { content: 'changed' } },
      { seq: 2, envelope: { sender: 'Person', content: 'two' } },
      {
        seq: 3,
        envelope: { sender: '小X', content: 'four' },
      },
    ]);
    expect(left.map((item) => item.operationId)).toEqual(['c', 'd']);
  });
});

describe('resolveMessageDeliveryStatus', () => {
  it('treats empty receipts array as sent and null/undefined as delivered', () => {
    expect(resolveMessageDeliveryStatus([])).toBe('sent');
    expect(resolveMessageDeliveryStatus(null)).toBe('delivered');
  });

  it('keeps a single tick while the bot has only queued the turn', () => {
    expect(resolveMessageDeliveryStatus([{ delivered: 'queued' }])).toBe(
      'sent'
    );
  });

  it('uses two ticks once the bot has claimed or started the turn', () => {
    expect(resolveMessageDeliveryStatus([{ delivered: 'claimed' }])).toBe(
      'delivered'
    );
    expect(resolveMessageDeliveryStatus([{ delivered: 'dispatched' }])).toBe(
      'delivered'
    );
  });

  it('maps seven receipt states without changing sent/delivered', () => {
    expect(resolveMessageDeliveryStatus([{ state: 'queued' }])).toBe('sent');
    expect(resolveMessageDeliveryStatus([{ state: 'processing' }])).toBe(
      'delivered'
    );
    expect(resolveMessageDeliveryStatus([{ state: 'replied' }])).toBe(
      'delivered'
    );
    expect(resolveMessageDeliveryStatus([{ state: 'passed' }])).toBe('sent');
    expect(resolveMessageDeliveryStatus([{ state: 'timed_out' }])).toBe('sent');
    expect(resolveMessageDeliveryStatus([{ state: 'cancelled' }])).toBe('sent');
    expect(resolveMessageDeliveryStatus([{ state: 'failed' }])).toBe(null);
    expect(
      resolveMessageDeliveryStatus([
        { state: 'cancelled', error_code: 'chain_limit_exceeded' },
      ])
    ).toBe('sent');
  });
});

describe('working members copy', () => {
  it('joins nicknames with 顿号 and 和, then a spaced working phrase', () => {
    expect(formatWorkingMembersCopy([])).toBe('');
    expect(formatWorkingMembersCopy(['小A'])).toBe('小A 正在工作...');
    expect(formatWorkingMembersCopy(['小A', '小B'])).toBe(
      '小A和小B 正在工作...'
    );
    expect(formatWorkingMembersCopy(['Ulwonder', 'Designer', 'Master'])).toBe(
      'Ulwonder、Designer和Master 正在工作...'
    );
    expect(formatWorkingMembersCopy(['小A'], '正在深度求索...')).toBe(
      '小A 正在深度求索...'
    );
  });

  it('treats an in-flight or in-progress conversation as working', () => {
    expect(isMemberWorking({ turn_in_flight: true })).toBe(true);
    expect(isMemberWorking({ status: 'inprogress' })).toBe(true);
    expect(isMemberWorking({ turn_in_flight: false, status: 'todo' })).toBe(
      false
    );
    expect(isMemberWorking(undefined)).toBe(false);
  });
});

describe('memberTabTitle', () => {
  it('uses the group name for group threads and the member name for DMs', async () => {
    const { memberTabTitle } = await import('./spaceModel');
    expect(memberTabTitle('小A', { kind: 'group', name: '设计' })).toBe('设计');
    expect(memberTabTitle('小A', { kind: 'dm', name: '小A' })).toBe('小A');
    expect(memberTabTitle('小A', { kind: 'direct' })).toBe('小A');
    expect(memberTabTitle('小A', { kind: 'group', name: ' ' })).toBe('小A');
    expect(memberTabTitle('小A', undefined)).toBe('小A');
  });
});

describe('sortMembersLeadFirst', () => {
  it('moves the lead member to the front and keeps the rest stable', () => {
    const roster = [
      { member_id: 'm1', nickname: '小A' },
      { member_id: 'm2', nickname: '小B' },
      { member_id: 'm3', nickname: '小C' },
    ];
    expect(
      sortMembersLeadFirst(roster, 'm2').map((item) => item.nickname)
    ).toEqual(['小B', '小A', '小C']);
    expect(
      sortMembersLeadFirst(roster, '').map((item) => item.nickname)
    ).toEqual(['小A', '小B', '小C']);
  });
});

describe('create group chat defaults', () => {
  it('names an unnamed group from member nicknames', () => {
    expect(defaultGroupChatNameFromMembers([])).toBe('');
    expect(defaultGroupChatNameFromMembers(['小A'])).toBe('小A');
    expect(defaultGroupChatNameFromMembers(['小A', '小B'])).toBe('小A、小B');
    expect(defaultGroupChatNameFromMembers(['小A', '小B'], ['小A、小B'])).toBe(
      '小A、小B 2'
    );
  });

  it('flattens unique bots and skips ones already in the group', () => {
    const botA: SpaceMember = {
      nickname: '小A',
      kind: 'agent',
      visible_to_agents: 1,
      conversation_id: 'conv-a',
      member_id: 'm-a',
    };
    const botB: SpaceMember = {
      nickname: '小B',
      kind: 'agent',
      visible_to_agents: 1,
      conversation_id: 'conv-b',
      member_id: 'm-b',
    };
    const user: SpaceMember = {
      nickname: '你',
      kind: 'user',
      visible_to_agents: 0,
      conversation_id: null,
    };
    const bots = uniqueBotsForGroupMemberPicker({
      directMembers: [botA],
      unassignedMembers: [botB],
      membersBySpace: {
        s1: [botA, user],
        s2: [botA, botB],
      },
      excludeConversationIds: new Set(['conv-a']),
    });
    expect(bots.map((bot) => bot.conversation_id)).toEqual(['conv-b']);
  });
});

describe('collab DM bootstrap prompt', () => {
  it('generates concise DS-Bot kickoff prompts for user-created, bot-created, and master bots', () => {
    const prompt = buildCollabDmBootstrapPrompt({
      userName: '你',
      botName: '小E',
      personaPrompt: '擅长写代码的搭档',
      spaceId: 'direct:member-e',
    });
    expect(isCollabDmBootstrapPrompt(prompt)).toBe(true);
    expect(
      isCollabDmBootstrapPrompt(
        `[协作空间消息]\n${COLLAB_DM_BOOTSTRAP_PREFIX}\n引导`
      )
    ).toBe(true);
    expect(prompt.startsWith(COLLAB_DM_BOOTSTRAP_PREFIX)).toBe(true);
    expect(prompt.endsWith(COLLAB_DM_BOOTSTRAP_SUFFIX)).toBe(true);
    expect(stripCollabDmBootstrapTags(prompt)).toBe(
      '用户刚创建了你。请用一句简短的话向用户打个招呼，再用一个简短的问题询问接下来重点做什么。\n如果人设另有说明，以人设为准。'
    );
    expect(prompt).not.toContain('# 身份');
    expect(prompt).not.toContain('# 本回合立刻执行');
    expect(prompt).not.toContain('direct:member-e');

    const botCreatedPrompt = buildCollabDmBootstrapPrompt({
      botName: 'Hailer',
      creatorName: 'Lander',
    });
    expect(stripCollabDmBootstrapTags(botCreatedPrompt)).toBe(
      'Lander 刚为用户创建了你。请用一句简短的话向用户打个招呼，再用一个简短的问题询问从哪里开始，保持简短。\n如果人设另有说明，以人设为准。'
    );

    const masterPrompt = buildCollabDmBootstrapPrompt({
      botName: DEFAULT_MASTER_BOT_NAME,
      personaPrompt: DEFAULT_MASTER_BOT_PERSONA_PROMPT,
      isMaster: true,
    });
    expect(stripCollabDmBootstrapTags(masterPrompt)).toBe(
      '你刚被设为用户的总管 Bot。请用一两句简短的话向用户打个招呼：说明你会帮用户统筹管理 Bot 团队，有需要决策的事都可以找你；再用一个简短的问题询问最想先让团队帮什么忙。\n如果人设另有说明，以人设为准。'
    );
    expect(isCollabDmBootstrapPrompt('你好')).toBe(false);
  });

  it('hides bootstrap text from contact last-message previews', () => {
    expect(contactLastMessagePreview({ lastPreview: '你好，我是小E' })).toBe(
      '你好，我是小E'
    );
    expect(
      contactLastMessagePreview({
        lastPreview: `${COLLAB_DM_BOOTSTRAP_PREFIX}\n引导`,
      })
    ).toBe('');
    expect(contactLastMessagePreview({}, '备选一句')).toBe('备选一句');
  });

  it('parses cross-chat peers from nicknames or structured envelopes', () => {
    expect(
      extractEnvelopeCrossChatMeta({
        crossChatSentTo: ['小B', '小C'],
        crossChatReceivedFrom: { kind: 'member', name: '小A' },
      })
    ).toEqual({
      sentTo: [
        { kind: 'member', name: '小B' },
        { kind: 'member', name: '小C' },
      ],
      receivedFrom: [{ kind: 'member', name: '小A' }],
      replyReceivedFrom: [],
    });
    expect(
      extractEnvelopeCrossChatMeta({
        cross_chat_sent_to: [{ kind: 'group', name: '设计', id: 's1' }],
      })
    ).toEqual({
      sentTo: [{ kind: 'group', name: '设计', id: 's1' }],
      receivedFrom: [],
      replyReceivedFrom: [],
    });
  });
});

describe('DM streaming draft replacement and space event/round helpers', () => {
  it('replaces streaming DM draft with persisted message for the same turnId while preserving pre/post-cutover order', () => {
    const existing = [
      { id: 'legacy-10', seq: 10, envelope: { content: '旧版用户消息' } },
      { id: 'legacy-11', seq: 11, envelope: { content: '旧版助手回复' } },
      { id: 'msg-1', seq: 1, envelope: { content: '新版用户消息' } },
      {
        id: 'draft:turn-1',
        seq: 1,
        turnId: 'turn-1',
        streaming: true,
        envelope: { content: '正在输入...' },
      },
    ];
    const incoming = [
      { id: 'legacy-10', seq: 10, envelope: { content: '旧版用户消息' } },
      { id: 'legacy-11', seq: 11, envelope: { content: '旧版助手回复' } },
      { id: 'msg-1', seq: 1, envelope: { content: '新版用户消息' } },
      {
        id: 'msg-2',
        seq: 2,
        turnId: 'turn-1',
        envelope: { content: '新版助手最终回复' },
      },
    ];
    const replaced = mergeDirectSpaceMessages(existing, incoming, true);
    expect(replaced.map((m) => m.id)).toEqual([
      'legacy-10',
      'legacy-11',
      'msg-1',
      'msg-2',
    ]);
    expect(replaced[3]?.envelope?.content).toBe('新版助手最终回复');
    expect(
      (replaced[3] as { streaming?: boolean } | undefined)?.streaming
    ).toBeUndefined();
  });

  it('keeps the user space bubble when a persisted agent reply shares that turnId', () => {
    const merged = mergeDirectSpaceMessages(
      [],
      [
        {
          id: 'msg-user',
          seq: 1,
          origin: 'user',
          turnId: 'turn-1',
          envelope: { content: '请继续' },
        },
        {
          id: 'msg-agent',
          seq: 2,
          origin: 'agent',
          turnId: 'turn-1',
          envelope: { content: '好的，我接着做' },
        },
      ],
      false
    );
    expect(merged.map((message) => message.id)).toEqual([
      'msg-user',
      'msg-agent',
    ]);
  });

  it('preserves mid-turn step bubble alongside subsequent streaming draft and final reply in the same turnId', () => {
    const step1Persisted = {
      id: 'msg-step-1',
      seq: 2,
      origin: 'agent',
      turnId: 'turn-1',
      envelope: {
        content:
          '我先查看一下 vibex-bot 规范和 manage_bot 工具参数，接着为你创建专门负责邮件管理的 Bot「Hailer」。',
      },
    };
    const step2Draft = {
      id: 'draft:turn-1:1',
      seq: 3,
      origin: 'agent',
      turnId: 'turn-1',
      streaming: true,
      envelope: { content: '已经为你创建好负责邮件管理的' },
    };
    const step2Final = {
      id: 'msg-step-2',
      seq: 3,
      origin: 'agent',
      turnId: 'turn-1',
      envelope: { content: '已经为你创建好负责邮件管理的 Bot「Hailer」了！' },
    };

    const withMidTurnAndDraft = mergeDirectSpaceMessages(
      [],
      [
        {
          id: 'msg-user',
          seq: 1,
          origin: 'user',
          envelope: { content: '创建一个新Bot，名叫Hailer，帮我做邮件管理' },
        },
        step1Persisted,
        step2Draft,
      ],
      false
    );
    expect(withMidTurnAndDraft.map((m) => m.id)).toEqual([
      'msg-user',
      'msg-step-1',
      'draft:turn-1:1',
    ]);

    const withFinal = mergeDirectSpaceMessages(
      withMidTurnAndDraft,
      [
        {
          id: 'msg-user',
          seq: 1,
          origin: 'user',
          envelope: { content: '创建一个新Bot，名叫Hailer，帮我做邮件管理' },
        },
        step1Persisted,
        step2Final,
      ],
      true
    );
    expect(withFinal.map((m) => m.id)).toEqual([
      'msg-user',
      'msg-step-1',
      'msg-step-2',
    ]);
  });

  it('keeps a follow-up user bubble while the previous turn is still streaming', () => {
    const merged = mergeDirectSpaceMessages(
      [],
      [
        {
          id: 'msg-first',
          seq: 1,
          origin: 'user',
          turnId: 'turn-1',
          envelope: { content: '先做这一件' },
        },
        {
          id: 'msg-second',
          seq: 2,
          origin: 'user',
          turnId: 'turn-1',
          envelope: { content: '再补一句' },
        },
        {
          id: 'draft:turn-1',
          seq: 1,
          origin: 'agent',
          turnId: 'turn-1',
          streaming: true,
          envelope: { content: '正在处理上一件...' },
        },
      ],
      false
    );
    expect(merged.map((message) => message.id)).toEqual([
      'msg-first',
      'msg-second',
      'draft:turn-1',
    ]);
  });

  it('parses kind and generation from collaboration space changed events', () => {
    expect(
      parseSpaceChangedEvent({
        workspaceId: 'w1',
        spaceId: 's1',
        seq: 7,
        kind: 'turn',
        generation: 3,
      })
    ).toEqual({
      workspaceId: 'w1',
      spaceId: 's1',
      seq: 7,
      kind: 'turn',
      generation: 3,
    });
  });

  it('formats round progress and keeps delivery status as sent until the round finishes', () => {
    const inFlightRound = [
      {
        nickname: '小A',
        state: 'replied',
        round_id: 'r1',
        round_ordinal: 1,
        round_state: 'open',
      },
      {
        nickname: '小B',
        state: 'processing',
        round_id: 'r1',
        round_ordinal: 2,
        round_state: 'open',
      },
      {
        nickname: '小C',
        state: 'queued',
        round_id: 'r1',
        round_ordinal: 3,
        round_state: 'open',
      },
    ];
    expect(formatRoundProgress(inFlightRound)).toEqual({
      completed: 1,
      total: 3,
      state: 'open',
      label: '1/3 成员已回复',
    });
    expect(resolveMessageDeliveryStatus(inFlightRound)).toBe('sent');

    const finishedRound = [
      {
        nickname: '小A',
        state: 'replied',
        round_id: 'r1',
        round_ordinal: 1,
        round_state: 'closed',
      },
      {
        nickname: '小B',
        state: 'passed',
        round_id: 'r1',
        round_ordinal: 2,
        round_state: 'closed',
      },
      {
        nickname: '小C',
        state: 'timed_out',
        round_id: 'r1',
        round_ordinal: 3,
        round_state: 'closed',
      },
    ];
    expect(formatRoundProgress(finishedRound)).toEqual({
      completed: 3,
      total: 3,
      state: 'closed',
      label: '3/3 成员已回复',
    });
    expect(resolveMessageDeliveryStatus(finishedRound)).toBe('delivered');
  });

  it('maps a joined group seat conversation to its bot identity', () => {
    const index = indexIdentityMemberIdsByConversation([
      {
        kind: 'agent',
        member_id: 'seat-muse',
        identity_member_id: 'identity-muse',
        nickname: 'Muse',
        // Joining a group creates a hidden per-thread session.
        conversation_id: 'group-session-muse',
      },
      {
        kind: 'agent',
        member_id: 'seat-builder',
        identity_member_id: 'identity-builder',
        nickname: 'Builder',
        conversation_id: 'group-session-builder',
      },
    ]);

    expect(index.get('group-session-muse')).toBe('identity-muse');
    expect(index.get('group-session-builder')).toBe('identity-builder');
  });
});
