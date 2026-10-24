import { describe, expect, it } from 'vitest';

import {
  aggregateTokenOverview,
  uniqueAgentIds,
  type MemberUsageSnapshot,
} from './groupDetailsUsage';

const snapshots: MemberUsageSnapshot[] = [
  {
    memberKey: 'a',
    agentId: 'GROK',
    totalTokens: 20,
    byModel: [{ key: 'grok-4.6', label: 'grok-4.6', tokens: 20 }],
  },
  {
    memberKey: 'b',
    agentId: 'GROK',
    totalTokens: 30,
    byModel: [{ key: 'grok-4.6', label: 'grok-4.6', tokens: 30 }],
  },
  {
    memberKey: 'c',
    agentId: 'CLAUDE_CODE',
    totalTokens: 10,
    byModel: [{ key: 'opus', label: 'opus', tokens: 10 }],
  },
];

describe('group details usage aggregation', () => {
  it('keeps one agent id when several members share a subscription', () => {
    expect(uniqueAgentIds(snapshots.slice(0, 2))).toEqual(['GROK']);
  });

  it('lists each distinct agent once, in first-seen order', () => {
    expect(uniqueAgentIds(snapshots)).toEqual(['GROK', 'CLAUDE_CODE']);
  });

  it('sums chat-level tokens and per-model totals without a cache rate', () => {
    expect(aggregateTokenOverview(snapshots)).toEqual({
      totalTokens: 60,
      byModel: [
        { key: 'grok-4.6', label: 'grok-4.6', tokens: 50 },
        { key: 'opus', label: 'opus', tokens: 10 },
      ],
    });
    expect(aggregateTokenOverview(snapshots)).not.toHaveProperty('cacheRate');
  });
});
