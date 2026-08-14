import { describe, expect, it } from 'vitest';
import type { ConversationRelationView } from 'shared/types';

import { summarizeConversationChildren } from './ConversationChildrenSummary';

function relation(
  id: string,
  activeTurnStatus: string | null,
  metadata: unknown = {}
): ConversationRelationView {
  return {
    id,
    parentConversationId: 'parent',
    childConversationId: `child-${id}`,
    kind: 'delegation',
    visibility: 'visible',
    metadata,
    child: {
      workspaceId: 'workspace',
      title: id,
      status: 'inprogress',
      activeTurnStatus,
      queuedInputCount: 0n,
      messageCount: 0n,
    },
  } as ConversationRelationView;
}

describe('summarizeConversationChildren', () => {
  it('projects persisted delegation budget usage and waiting children', () => {
    const policy = {
      maxCallsPerParent: 8,
      maxActiveChildren: 3,
    };
    const summary = summarizeConversationChildren([
      relation('one', 'running', { policy }),
      relation('two', 'blocked', { policy }),
      relation('three', null, { policy }),
    ]);

    expect(summary.activeCount).toBe(2);
    expect(summary.waitingCount).toBe(1);
    expect(summary.budget).toEqual({
      callsUsed: 3,
      maxCalls: 8,
      activeChildren: 2,
      maxActiveChildren: 3,
    });
  });

  it('does not fabricate a budget for fork or legacy relation metadata', () => {
    const child = relation('fork', null);
    child.kind = 'fork';

    expect(summarizeConversationChildren([child]).budget).toBeNull();
  });
});
