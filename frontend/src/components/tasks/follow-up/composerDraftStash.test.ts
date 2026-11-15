import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearComposerDraftStash,
  composerStashStorageKey,
  formatComposerStashPreview,
  formatComposerStashRelativeTime,
  loadComposerDraftStash,
  MAX_COMPOSER_STASH_ITEMS,
  popComposerDraftStash,
  pushComposerDraftStash,
  removeComposerDraftStash,
  reorderComposerDraftStash,
} from './composerDraftStash';
import { formatQuoteToken } from './sessionComposerStructuredTokens';

describe('composerDraftStash', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('maintains a 10-item LIFO stack and drops oldest drafts beyond capacity', () => {
    const scope = 'ws-lifo';
    for (let i = 1; i <= 12; i += 1) {
      pushComposerDraftStash(scope, {
        text: `Draft #${i}`,
        attachmentCount: i % 3,
        now: 1000 + i * 100,
      });
    }

    const items = loadComposerDraftStash(scope);
    expect(items).toHaveLength(MAX_COMPOSER_STASH_ITEMS);
    expect(items[0]?.text).toBe('Draft #12');
    expect(items[9]?.text).toBe('Draft #3');

    const { popped, items: remaining } = popComposerDraftStash(scope);
    expect(popped?.text).toBe('Draft #12');
    expect(remaining).toHaveLength(9);
    expect(remaining[0]?.text).toBe('Draft #11');
  });

  it('deduplicates consecutive identical drafts while preserving structured tokens verbatim', () => {
    const scope = 'ws-dedup';
    const richDraft = `Please inspect ${formatQuoteToken('a + b', {
      turnId: 'turn-1',
      annotation: 'overflow',
    })} and [@:app.ts](src/app.ts)`;

    pushComposerDraftStash(scope, {
      text: richDraft,
      attachmentCount: 1,
      now: 1000,
    });
    const afterDup = pushComposerDraftStash(scope, {
      text: richDraft,
      attachmentCount: 2,
      now: 2000,
    });

    expect(afterDup).toHaveLength(1);
    expect(afterDup[0]?.text).toBe(richDraft);
    expect(afterDup[0]?.attachmentCount).toBe(2);
    expect(afterDup[0]?.createdAt).toBe(2000);

    const preview = formatComposerStashPreview(richDraft, 50);
    expect(preview).toContain('@a + ...');
    expect(preview).toContain('@app.ts');
    expect(Array.from(preview).length).toBeLessThanOrEqual(51);
  });

  it('supports reorder, delete, clear, and graceful corrupt JSON / quota fallback', () => {
    const scope = 'ws-ops';
    pushComposerDraftStash(scope, { text: 'First', now: 100 });
    pushComposerDraftStash(scope, { text: 'Second', now: 200 });
    pushComposerDraftStash(scope, { text: 'Third', now: 300 });

    const reordered = reorderComposerDraftStash(scope, 2, 0);
    expect(reordered.map((item) => item.text)).toEqual([
      'First',
      'Third',
      'Second',
    ]);

    const afterDelete = removeComposerDraftStash(scope, reordered[1]!.id);
    expect(afterDelete.map((item) => item.text)).toEqual(['First', 'Second']);

    // Corrupt localStorage JSON falls back cleanly to in-memory copy
    window.localStorage.setItem(composerStashStorageKey(scope), '{corrupt-json');
    expect(loadComposerDraftStash(scope).map((item) => item.text)).toEqual([
      'First',
      'Second',
    ]);

    // QuotaExceededError falls back without throwing
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
    expect(() =>
      pushComposerDraftStash(scope, { text: 'Quota survivor', now: 400 })
    ).not.toThrow();
    expect(loadComposerDraftStash(scope)[0]?.text).toBe('Quota survivor');
    setItemSpy.mockRestore();

    expect(clearComposerDraftStash(scope)).toEqual([]);
  });

  it('formats relative timestamps concisely', () => {
    const labels = {
      justNow: 'Just now',
      minutesAgo: (count: number) => `${count}m ago`,
      hoursAgo: (count: number) => `${count}h ago`,
      daysAgo: (count: number) => `${count}d ago`,
    };
    const base = 1_000_000_000;
    expect(formatComposerStashRelativeTime(base - 15_000, base, labels)).toBe(
      'Just now'
    );
    expect(formatComposerStashRelativeTime(base - 5 * 60_000, base, labels)).toBe(
      '5m ago'
    );
    expect(
      formatComposerStashRelativeTime(base - 3 * 3_600_000, base, labels)
    ).toBe('3h ago');
  });
});
