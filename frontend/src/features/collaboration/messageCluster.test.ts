import { describe, expect, it } from 'vitest';

import {
  COLLAB_ASSISTANT_AVATAR_PX,
  memberMessageClusters,
  showsClusterAvatar,
  showsClusterName,
} from './messageCluster';

describe('memberMessageClusters', () => {
  it('keeps a single assistant message as solo', () => {
    expect(
      memberMessageClusters([{ fromYou: false, authorKey: 'conv-a' }])
    ).toEqual(['solo']);
  });

  it('splits a two-message run into start then end', () => {
    expect(
      memberMessageClusters([
        { fromYou: false, authorKey: 'conv-a' },
        { fromYou: false, authorKey: 'conv-a' },
      ])
    ).toEqual(['start', 'end']);
  });

  it('marks the middle of a three-message run', () => {
    expect(
      memberMessageClusters([
        { fromYou: false, authorKey: 'conv-a' },
        { fromYou: false, authorKey: 'conv-a' },
        { fromYou: false, authorKey: 'conv-a' },
      ])
    ).toEqual(['start', 'middle', 'end']);
  });

  it('breaks a run on a user message', () => {
    expect(
      memberMessageClusters([
        { fromYou: false, authorKey: 'conv-a' },
        { fromYou: false, authorKey: 'conv-a' },
        { fromYou: true, authorKey: '' },
        { fromYou: false, authorKey: 'conv-a' },
      ])
    ).toEqual(['start', 'end', null, 'solo']);
  });

  it('breaks a run when the assistant changes', () => {
    expect(
      memberMessageClusters([
        { fromYou: false, authorKey: 'conv-a' },
        { fromYou: false, authorKey: 'conv-b' },
        { fromYou: false, authorKey: 'conv-a' },
      ])
    ).toEqual(['solo', 'solo', 'solo']);
  });

  it('does not merge assistant messages that lack an author key', () => {
    expect(
      memberMessageClusters([
        { fromYou: false, authorKey: '' },
        { fromYou: false, authorKey: '' },
      ])
    ).toEqual(['solo', 'solo']);
  });
});

describe('cluster chrome flags', () => {
  it('shows the name on the first bubble and the avatar on the last', () => {
    expect(showsClusterName('solo')).toBe(true);
    expect(showsClusterAvatar('solo')).toBe(true);
    expect(showsClusterName('start')).toBe(true);
    expect(showsClusterAvatar('start')).toBe(false);
    expect(showsClusterName('middle')).toBe(false);
    expect(showsClusterAvatar('middle')).toBe(false);
    expect(showsClusterName('end')).toBe(false);
    expect(showsClusterAvatar('end')).toBe(true);
    expect(showsClusterName(null)).toBe(false);
    expect(showsClusterAvatar(null)).toBe(false);
  });

  it('sizes assistant avatars at 40px', () => {
    expect(COLLAB_ASSISTANT_AVATAR_PX).toBe(40);
  });
});
