import { describe, expect, it } from 'vitest';

import { buildCollaborationUserMessageNavEntries } from './collaborationMessageNav';

describe('buildCollaborationUserMessageNavEntries', () => {
  it('keeps only user bubbles and preserves their log indexes', () => {
    expect(
      buildCollaborationUserMessageNavEntries([
        {
          seq: 1,
          envelope: { sender: 'Person', content: '用户第一条' },
        },
        {
          seq: 2,
          envelope: { sender: '小A', content: '助手回复' },
        },
        {
          seq: 3,
          origin: 'system',
          envelope: { sender: 'system', summary: 'collaboration_limit' },
        },
        {
          seq: 4,
          envelope: { sender: 'Person', content: '用户第二条' },
        },
        {
          seq: 5,
          envelope: { sender: 'Person', content: '扁平用户' },
        },
        {
          seq: 6,
          envelope: { sender: '小A', content: '扁平助手' },
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
      {
        key: 'space-msg-5',
        index: 4,
        ordinal: 3,
        preview: '扁平用户',
        additions: 0,
        deletions: 0,
      },
    ]);
  });
});
