import { describe, expect, it } from 'vitest';

import {
  attentionByMember,
  buildThreadList,
  collectMembers,
  factScopeTag,
  memberPresence,
  parseCard,
  parseHandoff,
  parseWorktreeConflict,
  processSummary,
  replyTargetOf,
  receiptState,
  segmentStream,
  togglePin,
  type ConversationFacts,
  type StreamMessage,
} from './threadModel';

const direct = 'unassigned:ws';

function snapshot() {
  return collectMembers(
    [
      { space_id: direct, name: '' },
      { space_id: 'g1', name: '登录重构' },
    ],
    {
      [direct]: [
        {
          member_id: 'm1',
          nickname: 'Alex',
          kind: 'agent',
          conversation_id: 'c1',
        },
        {
          member_id: 'm2',
          nickname: 'Blair',
          kind: 'agent',
          conversation_id: 'c2',
        },
        { nickname: '你', kind: 'user' },
      ],
      g1: [
        {
          member_id: 'm1',
          nickname: 'Alex',
          kind: 'agent',
          conversation_id: 'c1g',
        },
      ],
    },
    direct
  );
}

describe('thread model', () => {
  it('dedupes members across seats and keeps groups separate', () => {
    const { members, groups } = snapshot();
    expect(members.map((m) => m.memberId)).toEqual(['m1', 'm2']);
    expect(members[0].seats).toHaveLength(2);
    expect(members[0].seats[0].direct).toBe(true);
    expect(groups).toEqual([
      { spaceId: 'g1', name: '登录重构', memberIds: ['m1'] },
    ]);
  });

  it('derives presence from every seat', () => {
    const { members } = snapshot();
    const conversations = new Map<string, ConversationFacts>([
      [
        'c1g',
        { conversation_id: 'c1g', turn_in_flight: true, updated_at: '2' },
      ],
      ['c2', { conversation_id: 'c2', status: 'sleeping' }],
    ]);
    const alex = memberPresence(
      members[0],
      conversations,
      new Map([['c1', 1]])
    );
    expect(alex.state).toBe('busy');
    expect(alex.line).toBe('正在 #登录重构 处理… 另 1 个排队');
    expect(memberPresence(members[1], conversations).state).toBe('sleeping');
    expect(memberPresence(members[1], new Map()).state).toBe('idle');
  });

  it('sorts pins first, then recent activity, and filters', () => {
    const { members, groups } = snapshot();
    const base = {
      members,
      groups,
      conversations: new Map(),
      activity: {
        'member:m1': { at: '2026-01-01' },
        'member:m2': { at: '2026-03-01' },
        'group:g1': { at: '2026-02-01' },
      },
      pins: ['group:g1'],
      attentionByMember: attentionByMember([
        { member_id: 'm1', status: 'pending' },
        { member_id: 'm1', status: 'resolved' },
      ]),
    };
    const all = buildThreadList(base);
    expect(all.map((i) => i.key)).toEqual([
      'group:g1',
      'member:m2',
      'member:m1',
    ]);
    expect(all[0].attention).toBe(1);
    expect(
      buildThreadList({ ...base, filter: 'group' }).map((i) => i.key)
    ).toEqual(['group:g1']);
    expect(
      buildThreadList({ ...base, query: 'bla' }).map((i) => i.key)
    ).toEqual(['member:m2']);
    expect(togglePin(['a'], 'a')).toEqual([]);
    expect(togglePin([], 'a')).toEqual(['a']);
  });

  it('parses handoff, cards and worktree conflicts', () => {
    const handoff = parseHandoff(
      '<handoff id="h1" depth="2"><done>写好接口</done><inputs_constraints>别改 schema</inputs_constraints><ask>补测试 &amp; 文档</ask></handoff>'
    );
    expect(handoff).toEqual({
      id: 'h1',
      depth: 2,
      done: '写好接口',
      inputsConstraints: '别改 schema',
      ask: '补测试 & 文档',
    });
    expect(
      parseCard(
        '<card kind="ask" id="k1"><question>用哪个?</question><options>A|B</options></card>'
      )
    ).toEqual({
      kind: 'ask',
      id: 'k1',
      question: '用哪个?',
      options: ['A', 'B'],
    });
    expect(
      parseCard(
        '<card kind="approval" id="k2"><action>删除</action><command>rm x</command><reason>清理</reason></card>'
      )
    ).toMatchObject({ kind: 'approval', command: 'rm x' });
    expect(
      parseWorktreeConflict(
        '<worktree_conflict holder="Alex" branch="b" path="/p"/>'
      )
    ).toEqual({ holder: 'Alex', branch: 'b', path: '/p' });
    expect(parseCard('hello')).toBeNull();
  });

  it('folds agent-to-agent runs but keeps user-facing agent messages', () => {
    const msg = (
      seq: number,
      origin: string,
      to: string[] = [],
      content = 'x'
    ): StreamMessage => ({
      seq,
      origin,
      envelope: {
        actor: `vibex://space/g1/member/${seq % 2 ? 'Alex' : 'Blair'}`,
        content,
        to,
      },
    });
    const segments = segmentStream([
      msg(1, 'user'),
      msg(2, 'agent'),
      msg(3, 'agent'),
      msg(4, 'agent', ['vibex://space/g1/user']),
      msg(5, 'agent', [], '<handoff><done>d</done></handoff>'),
    ]);
    expect(segments.map((s) => s.kind)).toEqual([
      'message',
      'agent-fold',
      'message',
      'message',
    ]);
    const fold = segments[1];
    expect(fold.kind === 'agent-fold' && fold.messages).toHaveLength(2);
  });

  it('maps receipts, scopes and process summaries', () => {
    expect(receiptState({ state: 'limit_reached' })).toBe('limit_reached');
    expect(receiptState({ state: 'replied', delivered: 'failed' })).toBe(
      'failed'
    );
    expect(receiptState({})).toBe('queued');
    expect(factScopeTag('global', new Map()).kind).toBe('global');
    expect(
      factScopeTag('thread:g1', new Map([['g1', '登录重构']])).label
    ).toContain('登录重构');
    expect(
      processSummary({
        blocks: [{ type: 'thinking' }, { type: 'tool_use' }, { type: 'text' }],
        duration_ms: 1500n,
      })
    ).toEqual({ steps: 2, tools: 1, durationMs: 1500 });
  });
});

describe('message origin and reply correlation', () => {
  it('reads origin, id and in_reply_to off the wire shape', () => {
    const wire: StreamMessage[] = JSON.parse(
      JSON.stringify([
        {
          id: 'm-1',
          seq: 1,
          origin: 'agent',
          envelope: {
            actor: 'vibex://space/g1/member/小A',
            content: '接口好了吗',
          },
        },
        {
          id: 'm-2',
          seq: 2,
          origin: 'agent',
          in_reply_to: 'm-1',
          envelope: {
            actor: 'vibex://space/g1/member/小B',
            content: '好了',
            inReplyTo: 'vibex://space-message/m-1',
          },
        },
      ])
    );
    expect(wire[1].origin).toBe('agent');
    expect(replyTargetOf(wire[1], wire)?.id).toBe('m-1');
    expect(replyTargetOf(wire[0], wire)).toBeNull();
    expect(replyTargetOf({ ...wire[1], in_reply_to: 'gone' }, wire)).toBeNull();
  });
});
