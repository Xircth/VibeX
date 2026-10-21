import { describe, expect, it } from 'vitest';
import type {
  MessageTurn,
  SessionStats,
  TimelineRow,
  TurnUsage,
} from 'shared/types';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import {
  aggregateFileChanges,
  buildSessionDetails,
  protocolSpend,
  resolveReportedTotal,
  type SessionDetailsFacts,
  usageByMessage,
  usageByModel,
} from './sessionDetailsModel';

function usage(
  input: number,
  output: number,
  extra: Partial<TurnUsage> = {}
): TurnUsage {
  return {
    input_tokens: BigInt(input),
    output_tokens: BigInt(output),
    cache_creation_input_tokens: 0n,
    cache_read_input_tokens: 0n,
    context_window_max: null,
    ...extra,
  };
}

function row(
  id: string,
  role: MessageTurn['role'],
  partial: Partial<MessageTurn> = {}
): ConversationTimelineTurn {
  return {
    key: id,
    phase: 'settled',
    revision: 1n,
    turn: {
      id,
      role,
      blocks: [],
      timestamp: '2026-01-01T00:00:00.000Z',
      ...partial,
    },
  };
}

function facts(
  partial: Partial<SessionDetailsFacts> = {}
): SessionDetailsFacts {
  return {
    sessionId: 'session-1',
    hasDetail: true,
    error: null,
    title: 'Toast 对比',
    status: 'inprogress',
    agentId: 'grok',
    model: 'grok-4.6',
    acpSessionId: 'acp-1',
    externalSessionId: 'ext-1',
    turnInFlight: false,
    sessionStats: null,
    truncated: false,
    ...partial,
  };
}

describe('session details usage', () => {
  it('does not treat an all-zero breakdown or context occupancy as spend', () => {
    expect(protocolSpend(usage(0, 0))).toBeNull();
    expect(
      protocolSpend(
        usage(0, 0, {
          context_used: 12_000n,
          context_window_max: 200_000n,
        })
      )
    ).toBeNull();
    expect(protocolSpend(usage(10, 4, { cache_read_input_tokens: 6n }))).toBe(
      20
    );
  });

  it('uses the larger reported total after the transcript is fully loaded', () => {
    const turns = [
      row('u1', 'user', {
        blocks: [{ type: 'text', text: 'first' }],
      }),
      row('a1', 'assistant', {
        model: 'grok-4.6',
        usage: usage(10, 5),
      }),
      row('u2', 'user', {
        blocks: [{ type: 'text', text: 'second' }],
      }),
      row('a2', 'assistant', {
        model: 'grok-4.6',
        usage: usage(0, 0, { context_used: 9_000n }),
      }),
    ];

    expect(
      resolveReportedTotal({
        turns,
        sessionStats: { total_tokens: 100n } as SessionStats,
        truncated: false,
      })
    ).toBe(100);
    expect(
      resolveReportedTotal({
        turns: [row('a-live', 'assistant', { usage: usage(900, 50) })],
        sessionStats: { total_tokens: 100n } as SessionStats,
        truncated: false,
      })
    ).toBe(950);
    expect(usageByModel(turns)).toEqual([
      { key: 'grok-4.6', label: 'grok-4.6', tokens: 15 },
    ]);
    expect(usageByMessage(turns).map((item) => item.tokens)).toEqual([
      15,
      null,
    ]);
  });

  it('uses the folded session total when older history is not loaded', () => {
    const turns = [
      row('a-live', 'assistant', {
        model: 'grok-4.6',
        usage: usage(40, 10),
      }),
    ];
    expect(
      resolveReportedTotal({
        turns,
        sessionStats: { total_tokens: 800n } as SessionStats,
        truncated: true,
      })
    ).toBe(800);
  });

  it('raises a truncated total when the live window outgrows the fold', () => {
    const turns = [row('a-live', 'assistant', { usage: usage(900, 50) })];
    expect(
      resolveReportedTotal({
        turns,
        sessionStats: { total_tokens: 800n } as SessionStats,
        truncated: true,
      })
    ).toBe(950);
  });
});

describe('session details changes and identity', () => {
  it('sums later edits of the same file and keeps a missing count missing', () => {
    const rows: TimelineRow[] = [
      {
        row_id: 'c1',
        revision: 1n,
        row: {
          kind: 'file_change_summary',
          summary: {
            source: 'checkpoint',
            files: [
              {
                path: 'src/toast.tsx',
                change_kind: 'modified',
                additions: 10n,
                deletions: 2n,
              },
            ],
          },
        },
      },
      {
        row_id: 'c2',
        revision: 2n,
        row: {
          kind: 'file_change_summary',
          summary: {
            source: 'checkpoint',
            files: [
              {
                path: 'src/toast.tsx',
                change_kind: 'modified',
                additions: 3n,
                deletions: null,
              },
              {
                path: 'src/toast.css',
                change_kind: 'added',
                additions: null,
                deletions: null,
              },
            ],
          },
        },
      },
    ];

    expect(aggregateFileChanges(rows)).toEqual({
      files: [
        {
          path: 'src/toast.tsx',
          changeKind: 'modified',
          additions: 13,
          deletions: 2,
          oldPath: null,
        },
        {
          path: 'src/toast.css',
          changeKind: 'added',
          additions: null,
          deletions: null,
          oldPath: null,
        },
      ],
      additions: 13,
      deletions: 2,
    });
  });

  it('builds a ready model from reported facts and keeps the extension id', () => {
    const model = buildSessionDetails({
      facts: facts({ status: 'done', turnInFlight: true, model: null }),
      turns: [
        row('u1', 'user', {
          blocks: [{ type: 'text', text: '请优化 Toast' }],
        }),
        row('a1', 'assistant', {
          blocks: [
            {
              type: 'plan',
              entries: [
                { content: '改布局', status: 'completed' },
                { content: '改样式', status: 'in_progress' },
              ],
            },
          ],
          usage: usage(8, 2, {
            context_used: 4_000n,
            context_window_max: 128_000n,
          }),
        }),
      ],
      sideRows: [],
      branch: ' master ',
      configOptions: [
        { key: 'model', label: 'Model', category: 'model', value: 'grok-4.6' },
      ],
    });

    expect(model).toMatchObject({
      kind: 'ready',
      status: 'inprogress',
      model: 'grok-4.6',
      branch: 'master',
      extensionId: 'acp-1',
      sessionId: 'session-1',
    });
    if (model.kind !== 'ready') return;
    expect(model.plan).toHaveLength(2);
    expect(model.messages).toEqual([
      {
        turnId: 'u1',
        ordinal: 1,
        preview: '请优化 Toast',
        changes: { files: [], additions: null, deletions: null },
      },
    ]);
    expect(model.activeMessageId).toBe('u1');
    expect(model.usage.totalTokens).toBe(10);
    expect(model.usage.cacheRate).toBe(0);
    expect(model.usage.contextUsed).toBe(4_000);
    expect(model.usage.contextWindowMax).toBe(128_000);
  });

  it('stays empty without a session and does not invent a zero total', () => {
    expect(
      buildSessionDetails({
        facts: facts({ sessionId: null, hasDetail: false }),
        turns: [],
        sideRows: [],
        branch: null,
        configOptions: [],
      }).kind
    ).toBe('empty');

    const model = buildSessionDetails({
      facts: facts(),
      turns: [
        row('a1', 'assistant', {
          usage: usage(0, 0, { context_used: 1_000n }),
        }),
      ],
      sideRows: [],
      branch: null,
      configOptions: [],
    });
    expect(model.kind === 'ready' && model.usage.totalTokens).toBeNull();
    expect(model.kind === 'ready' && model.usage.cacheRate).toBeNull();
  });

  it('keeps a finished session total, cache rate, and model row', () => {
    const model = buildSessionDetails({
      facts: facts({
        status: 'done',
        sessionStats: {
          total_tokens: 100n,
          total_duration_ms: 0n,
          total_usage: usage(20, 10, { cache_read_input_tokens: 70n }),
          context_window_used_tokens: null,
          context_window_max_tokens: null,
          context_window_usage_percent: null,
        },
        truncated: false,
      }),
      turns: [
        row('u1', 'user', { blocks: [{ type: 'text', text: 'hello' }] }),
        row('a1', 'assistant', {
          usage: usage(0, 0, {
            context_used: 9_000n,
            context_window_max: 200_000n,
          }),
        }),
      ],
      sideRows: [
        {
          row_id: 'diff-1|user=u1',
          revision: 1n,
          row: {
            kind: 'file_change_summary',
            turn_id: 'a1',
            summary: {
              source: 'checkpoint',
              files: [
                {
                  path: 'src/toast.tsx',
                  change_kind: 'modified',
                  additions: 4n,
                  deletions: 1n,
                },
              ],
            },
          },
        },
      ],
      branch: null,
      configOptions: [],
      currentTurnId: 'a1',
    });

    expect(model.kind).toBe('ready');
    if (model.kind !== 'ready') return;
    expect(model.status).toBe('done');
    expect(model.activeMessageId).toBe('u1');
    expect(model.messages[0]?.changes.files).toEqual([
      {
        path: 'src/toast.tsx',
        changeKind: 'modified',
        additions: 4,
        deletions: 1,
        oldPath: null,
      },
    ]);
    expect(model.usage.totalTokens).toBe(100);
    expect(model.usage.cacheRate).toBeCloseTo(70 / 90);
    expect(model.usage.itemized).toBe(false);
    expect(model.usage.byModel).toEqual([
      { key: 'grok-4.6', label: 'grok-4.6', tokens: 100 },
    ]);
    expect(model.usage.byMessage.map((item) => item.tokens)).toEqual([null]);
  });
});
