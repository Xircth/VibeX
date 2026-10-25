import { describe, expect, it } from 'vitest';

import {
  COPY,
  agentRoster,
  deliveryFailureCopy,
  displayName,
  insertMention,
  latestMessageSeq,
  mentionSuggestions,
  mergeSpaceMessages,
  messageAuthor,
  parseSpaceChangedEvent,
  postRecipients,
  randomEnglishNickname,
  readSpaceTags,
  receiptStatusCopy,
  resolveMessageConversationId,
  sendErrorCopy,
  sortConversationsForSpaceMemberPicker,
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
  nextDefaultGroupChatName,
  resolvePrivateChatTarget,
  uniqueBotsForGroupMemberPicker,
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
    expect(COPY.defaultGroupChatName).toBe('群聊');
    expect(COPY.newMemberButton).toBe('新建助手');
    expect(COPY.createAssistantButton).toBe('创建助手');
    expect(COPY.createContactGroupButton).toBe('新建分组');
    expect(COPY.defaultContactGroupName).toBe('新分组');
    expect(COPY.groupDetailsButton).toBe('群组详情');
    expect(COPY.groupDetailsTab).toBe('详情');
    expect(COPY.groupCollectionTab).toBe('群收藏');
    expect(COPY.groupMembersTab).toBe('成员');
    expect(COPY.assistantDetailsButton).toBe('助手详情');
    expect(COPY.assistantDetailsTab).toBe('详情');
    expect(COPY.assistantCollectionTab).toBe('收藏');
    expect(COPY.assistantCustomizeTab).toBe('自定义');
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
    expect(userSendIsBroadcast('@不存在', members)).toBe(false);
  });

  it('inserts mentions and maps delivery copy', () => {
    expect(insertMention('请 @小', '小B')).toBe('请 @小B ');
    expect(messageAuthor({ actor: 'vibex://space/s/user' })).toBe('你');
    expect(messageAuthor({ actor: 'vibex://space/s/member/小B' })).toBe('小B');
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
          actor: 'vibex://space/s1/member/小A',
          attributedTo: 'vibex://conversation/conv-direct',
        },
        members
      )
    ).toBe('conv-direct');
    expect(
      resolveMessageConversationId(
        {
          actor: 'vibex://space/s1/member/小B',
        },
        members
      )
    ).toBe('b');

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
      spaceId: 'unassigned:w',
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
      spaceId: 'unassigned:w',
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
    expect(target.spaceId).toBe('unassigned:w');
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
      { seq: 2, envelope: { actor: 'vibex://space/s/user', content: 'two' } },
      {
        seq: 3,
        envelope: { actor: 'vibex://space/s/member/x', content: 'four' },
      },
    ]);
    expect(left.map((item) => item.operationId)).toEqual(['c', 'd']);
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

describe('create group chat defaults', () => {
  it('names an unnamed group 群聊, then 群聊 2', () => {
    expect(nextDefaultGroupChatName([])).toBe('群聊');
    expect(nextDefaultGroupChatName(['设计'])).toBe('群聊');
    expect(nextDefaultGroupChatName(['群聊'])).toBe('群聊 2');
    expect(nextDefaultGroupChatName(['群聊', '群聊 2', '设计'])).toBe('群聊 3');
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
