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
} from './spaceModel';

const members: SpaceMember[] = [
  { nickname: '小A', kind: 'agent', visible_to_agents: 1, conversation_id: 'a' },
  { nickname: '小B', kind: 'agent', visible_to_agents: 1, conversation_id: 'b' },
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
  { nickname: '隐藏', kind: 'agent', visible_to_agents: 0, conversation_id: 'h' },
];

describe('collaboration space model', () => {
  it('keeps the empty copy', () => {
    expect(COPY.emptyRoles).toBe('还没有角色');
    expect(COPY.newRole).toBe('新建角色');
    expect(COPY.emptySpaces).toBe('还没有协作空间');
    expect(COPY.newSpace).toBe('新建空间');
    expect(COPY.newSpaceButton).toBe('新建协作空间');
    expect(COPY.newMemberButton).toBe('新建成员');
    expect(COPY.newMemberFromSessionButton).toBe('从会话新建成员');
    expect(COPY.defaultSpaceName).toBe('默认空间');
    expect(COPY.unassignedSpaceName).toBe('未定空间');
    expect(COPY.noMemberSessions).toBe('暂无成员会话');
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
    ).toBe('部分成员没有送达');
    expect(deliveryFailureCopy([{ delivered: 'queued' }])).toBe('');
    expect(receiptStatusCopy({ delivered: 'queued' })).toBe('已排队');
    expect(receiptStatusCopy({ delivered: 'dispatched' })).toBe('已认领');
    expect(receiptStatusCopy({ delivered: 'claimed' })).toBe('已认领');
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
    expect(
      sorted.nonMemberConversations.map((c) => c.conversation_id)
    ).toEqual(['c-non-1', 'c-non-2']);
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
