import { describe, expect, it } from 'vitest';

import { buildCollaborationUserMessageNavEntries } from './collaborationMessageNav';

describe('buildCollaborationUserMessageNavEntries', () => {
  it('keeps only user bubbles and preserves their log indexes', () => {
    expect(
      buildCollaborationUserMessageNavEntries([
        {
          seq: 1,
          envelope: { actor: 'space/user', content: '用户第一条' },
        },
        {
          seq: 2,
          envelope: { actor: 'space/member/小A', content: '助手回复' },
        },
        {
          seq: 3,
          origin: 'system',
          envelope: { actor: 'space/system', summary: 'collaboration_limit' },
        },
        {
          seq: 4,
          envelope: { actor: 'space/user', content: '用户第二条' },
        },
      ])
    ).toEqual([
      {
        key: 'space-msg-1',
        index: 0,
        ordinal: 1,
        preview: '用户第一条',
        additions: 0,
        deletions: 0,
      },
      {
        key: 'space-msg-4',
        index: 3,
        ordinal: 2,
        preview: '用户第二条',
        additions: 0,
        deletions: 0,
      },
    ]);
  });
});
