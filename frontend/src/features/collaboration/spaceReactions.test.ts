import { describe, expect, it } from 'vitest';

import {
  reactionBadgeEmojis,
  reactionsFromUnknown,
  toggleSpaceReaction,
} from './spaceReactions';

describe('space reactions', () => {
  it('toggles the user emoji on and off and replaces a different one', () => {
    const added = toggleSpaceReaction([], '👍');
    expect(added).toEqual([{ emoji: '👍', actor: 'user' }]);
    expect(toggleSpaceReaction(added, '👍')).toEqual([]);
    expect(toggleSpaceReaction(added, '🎉')).toEqual([
      { emoji: '🎉', actor: 'user' },
    ]);
  });

  it('keeps other actors when the user toggles', () => {
    const current = [
      { emoji: '❤️', actor: '小A' },
      { emoji: '👍', actor: 'user' },
    ];
    expect(toggleSpaceReaction(current, '👍')).toEqual([
      { emoji: '❤️', actor: '小A' },
    ]);
  });

  it('reads reactions and lists unique badge emojis in order', () => {
    expect(
      reactionsFromUnknown([
        { emoji: '😄', actor: 'user' },
        { emoji: '😄', actor: '小A' },
        { emoji: '🎉', actor: '小B' },
        { emoji: '', actor: 'user' },
      ])
    ).toEqual([
      { emoji: '😄', actor: 'user' },
      { emoji: '😄', actor: '小A' },
      { emoji: '🎉', actor: '小B' },
    ]);
    expect(
      reactionBadgeEmojis([
        { emoji: '😄', actor: 'user' },
        { emoji: '😄', actor: '小A' },
        { emoji: '🎉', actor: '小B' },
      ])
    ).toEqual(['😄', '🎉']);
  });
});
