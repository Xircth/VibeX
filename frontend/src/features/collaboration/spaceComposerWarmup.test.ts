import { describe, expect, it } from 'vitest';

import {
  SPACE_WARMUP_COOLDOWN_MS,
  SpaceWarmupCooldown,
  shouldWarmupGroupComposer,
  spaceWarmupKey,
} from './spaceComposerWarmup';

describe('spaceComposerWarmup', () => {
  it('skips DMs and empty drafts', () => {
    expect(
      shouldWarmupGroupComposer({
        spaceId: 's1',
        isDirect: false,
        content: 'hello',
      })
    ).toBe(true);
    expect(
      shouldWarmupGroupComposer({
        spaceId: 's1',
        isDirect: true,
        content: 'hello',
      })
    ).toBe(false);
    expect(
      shouldWarmupGroupComposer({
        spaceId: 'direct:mem-a',
        isDirect: false,
        content: 'hello',
      })
    ).toBe(false);
    expect(
      shouldWarmupGroupComposer({
        spaceId: 's1',
        isDirect: false,
        content: '   ',
      })
    ).toBe(false);
  });

  it('rate-limits the same group and target for 30s', () => {
    const cooldown = new SpaceWarmupCooldown();
    expect(cooldown.tryAcquire('s1', [], 1_000)).toBe(true);
    expect(
      cooldown.tryAcquire('s1', [], 1_000 + SPACE_WARMUP_COOLDOWN_MS - 1)
    ).toBe(false);
    expect(cooldown.tryAcquire('s1', ['小B'], 1_000)).toBe(true);
    expect(cooldown.tryAcquire('s2', [], 1_000)).toBe(true);
    expect(
      cooldown.tryAcquire('s1', [], 1_000 + SPACE_WARMUP_COOLDOWN_MS)
    ).toBe(true);
  });

  it('treats recipient order as the same target', () => {
    expect(spaceWarmupKey('s1', ['小B', '小A'])).toBe(
      spaceWarmupKey('s1', ['小A', '小B'])
    );
  });
});
