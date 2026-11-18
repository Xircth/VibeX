import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_OPEN_SETTLE_PASSES,
  cancelVirtualizerFollowScroll,
  conversationFollowIntent,
  conversationOpenPinState,
  conversationTailFollowAction,
  conversationTailNeedsRescue,
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getDistanceFromConversationBottom,
  getVirtualRowTranslateY,
  getVirtualWindowTranslateY,
  scrollTopToRevealVirtualWindow,
  virtualListHeightPx,
  remeasureMountedVirtualRows,
  isConversationExpansionToggle,
  scrollTopAfterPrepend,
  isConversationNearBottom,
  measureScrollMargin,
  measureUnscaledBlockHeight,
  startAlignedVirtualOffset,
  scheduleMeasuredScrollToIndex,
  unscaledElementRect,
  wheelDetachesConversationFollow,
  ESTIMATED_CONVERSATION_ROW_HEIGHT,
  pendingAgentPermissionsFromEvents,
  pendingAgentPermissionsForSession,
} from './VirtualizedList';

describe('virtualized user-message navigation', () => {
  it('finds the visible virtual item nearest the viewport anchor', () => {
    expect(
      findViewportAnchorVirtualIndex(
        [
          { index: 4, start: 480 },
          { index: 5, start: 600 },
          { index: 6, start: 780 },
        ],
        500,
        600
      )
    ).toBe(5);
  });

  it('jumps to the latest user turn above the current virtual anchor', () => {
    expect(findPreviousUserMessageVirtualIndex([0, 4, 9], 6)).toBe(4);
  });

  it('falls back to the earliest user turn when already near the top', () => {
    expect(findPreviousUserMessageVirtualIndex([2, 8], 0)).toBe(2);
  });

  it('skips the anchored user turn so repeated jumps keep moving upward', () => {
    expect(findPreviousUserMessageVirtualIndex([0, 4, 9], 9)).toBe(4);
  });
});

describe('conversation bottom distance', () => {
  it('calculates distance from the visible viewport to the scroll bottom', () => {
    expect(
      getDistanceFromConversationBottom({
        scrollHeight: 1200,
        scrollTop: 700,
        clientHeight: 400,
      })
    ).toBe(100);
  });

  it('treats near-bottom scroll positions as pinned', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 760,
        clientHeight: 400,
      })
    ).toBe(true);
  });

  it('releases stick-to-bottom once the user scrolls away', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 650,
        clientHeight: 400,
      })
    ).toBe(false);
  });

  it('keeps the open path pinned while the timeline is still settling', () => {
    expect(
      conversationOpenPinState({
        settlePassesRemaining: CONVERSATION_OPEN_SETTLE_PASSES,
        itemCount: 0,
        nearBottom: false,
      })
    ).toEqual({
      pinned: true,
      settlePassesRemaining: CONVERSATION_OPEN_SETTLE_PASSES,
    });
    expect(
      conversationOpenPinState({
        settlePassesRemaining: 2,
        itemCount: 12,
        nearBottom: false,
      })
    ).toEqual({ pinned: true, settlePassesRemaining: 1 });
    expect(
      conversationOpenPinState({
        settlePassesRemaining: 0,
        itemCount: 12,
        nearBottom: false,
      })
    ).toEqual({ pinned: false, settlePassesRemaining: 0 });
  });

  it('lets an upward scroll inside the near-bottom band release the tail', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 755,
        clientHeight: 400,
      })
    ).toBe(true);
    expect(
      conversationFollowIntent({
        trustedUserScroll: true,
        previousScrollTop: 770,
        scrollTop: 755,
        nearBottom: true,
        attached: true,
      })
    ).toBe('detach');
  });

  it('reattaches only after a downward user scroll returns to the bottom', () => {
    expect(
      conversationFollowIntent({
        trustedUserScroll: true,
        previousScrollTop: 400,
        scrollTop: 520,
        nearBottom: false,
        attached: false,
      })
    ).toBe('keep');
    expect(
      conversationFollowIntent({
        trustedUserScroll: true,
        previousScrollTop: 700,
        scrollTop: 760,
        nearBottom: true,
        attached: false,
      })
    ).toBe('attach');
  });

  it('ignores programmatic and downward-only movement while attached', () => {
    expect(
      conversationFollowIntent({
        trustedUserScroll: false,
        previousScrollTop: 800,
        scrollTop: 640,
        nearBottom: false,
        attached: true,
      })
    ).toBe('keep');
    expect(wheelDetachesConversationFollow(-12)).toBe(true);
    expect(wheelDetachesConversationFollow(12)).toBe(false);
  });

  it('releases the tail when the open conversation expands, without ending open settle early', () => {
    expect(
      conversationTailFollowAction({
        attached: true,
        sessionChanged: false,
        expansionChanged: true,
        settlePassesRemaining: 4,
        itemCount: 12,
        nearBottom: true,
      })
    ).toEqual({
      action: 'release',
      attached: false,
      settlePassesRemaining: 0,
    });
    expect(
      conversationTailFollowAction({
        attached: true,
        sessionChanged: false,
        expansionChanged: false,
        settlePassesRemaining: CONVERSATION_OPEN_SETTLE_PASSES,
        itemCount: 8,
        nearBottom: false,
      })
    ).toEqual({
      action: 'pin',
      attached: true,
      settlePassesRemaining: CONVERSATION_OPEN_SETTLE_PASSES - 1,
    });
  });

  it('holds the tail pin while the viewport has no height', () => {
    expect(
      conversationOpenPinState({
        settlePassesRemaining: 4,
        itemCount: 6,
        nearBottom: false,
        viewportHeight: 0,
      })
    ).toEqual({ pinned: true, settlePassesRemaining: 4 });
    expect(
      conversationTailFollowAction({
        attached: true,
        sessionChanged: true,
        expansionChanged: false,
        settlePassesRemaining: 4,
        itemCount: 6,
        nearBottom: false,
        viewportHeight: 0,
      })
    ).toEqual({
      action: 'pin',
      attached: true,
      settlePassesRemaining: 4,
    });
    expect(
      conversationFollowIntent({
        trustedUserScroll: true,
        previousScrollTop: 400,
        scrollTop: 200,
        nearBottom: false,
        attached: true,
        viewportHeight: 0,
      })
    ).toBe('keep');
  });

  it('keeps follow attached when a scroll-height clamp moves scrollTop', () => {
    expect(
      conversationFollowIntent({
        trustedUserScroll: true,
        previousScrollTop: 800,
        scrollTop: 640,
        nearBottom: false,
        attached: true,
        previousScrollHeight: 1200,
        scrollHeight: 1040,
      })
    ).toBe('keep');
    expect(
      conversationFollowIntent({
        trustedUserScroll: true,
        previousScrollTop: 800,
        scrollTop: 640,
        nearBottom: false,
        attached: true,
        previousScrollHeight: 1200,
        scrollHeight: 1190,
      })
    ).toBe('detach');
  });

  it('rescues a followed tail whose last row is outside the window', () => {
    expect(
      conversationTailNeedsRescue({
        attached: true,
        viewportHeight: 400,
        itemCount: 12,
        visibleIndexes: [0, 1, 2],
      })
    ).toBe(true);
    expect(
      conversationTailNeedsRescue({
        attached: true,
        viewportHeight: 0,
        itemCount: 12,
        visibleIndexes: [],
      })
    ).toBe(false);
    expect(
      conversationTailNeedsRescue({
        attached: false,
        viewportHeight: 400,
        itemCount: 12,
        visibleIndexes: [0],
      })
    ).toBe(false);
    expect(
      conversationTailNeedsRescue({
        attached: true,
        viewportHeight: 400,
        itemCount: 3,
        visibleIndexes: [0, 1, 2],
      })
    ).toBe(false);
  });

  it('starts a new session pinned even if the previous one was released', () => {
    expect(
      conversationTailFollowAction({
        attached: false,
        sessionChanged: true,
        expansionChanged: true,
        settlePassesRemaining: 0,
        itemCount: 6,
        nearBottom: false,
      })
    ).toEqual({
      action: 'pin',
      attached: true,
      settlePassesRemaining: CONVERSATION_OPEN_SETTLE_PASSES - 1,
    });
  });

  it('treats only the expanded control itself as a conversation expansion toggle', () => {
    const header = document.createElement('div');
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    header.appendChild(icon);
    const nested = document.createElement('button');
    nested.textContent = 'src/0.ts';
    header.appendChild(nested);

    expect(isConversationExpansionToggle(icon)).toBe(true);
    expect(isConversationExpansionToggle(nested)).toBe(false);
    expect(isConversationExpansionToggle(null)).toBe(false);
  });

  it('cancels a virtualizer follow that is still reconciling', () => {
    const canceled: number[] = [];
    const virtualizer = {
      rafId: 7 as number | null,
      scrollState: { index: 3 },
      targetWindow: {
        cancelAnimationFrame(handle: number) {
          canceled.push(handle);
        },
      },
    };

    cancelVirtualizerFollowScroll(virtualizer);

    expect(canceled).toEqual([7]);
    expect(virtualizer.rafId).toBeNull();
    expect(virtualizer.scrollState).toBeNull();
  });

  it('offsets virtual rows by the measured scroll margin', () => {
    expect(getVirtualRowTranslateY(512, 96)).toBe('translateY(416px)');
  });

  it('anchors the in-flow window on the first visible row', () => {
    expect(getVirtualWindowTranslateY(512, 96)).toBe('translateY(416px)');
    expect(getVirtualWindowTranslateY(undefined, 96)).toBe('translateY(0px)');
  });

  it('grows the list box to the painted window when estimates are short', () => {
    expect(
      virtualListHeightPx({
        totalSize: 1000,
        windowStart: 2000,
        scrollMargin: 40,
        windowHeight: 800,
      })
    ).toBe(2760);
    expect(
      virtualListHeightPx({
        totalSize: 5000,
        windowStart: 100,
        scrollMargin: 40,
        windowHeight: 200,
      })
    ).toBe(5000);
  });

  it('reveals a translated window that the viewport missed', () => {
    expect(
      scrollTopToRevealVirtualWindow({
        scrollTop: 0,
        viewportHeight: 400,
        scrollHeight: 2400,
        windowStart: 2000,
        scrollMargin: 40,
        windowHeight: 800,
        followTail: true,
      })
    ).toBe(2000);
    expect(
      scrollTopToRevealVirtualWindow({
        scrollTop: 0,
        viewportHeight: 400,
        scrollHeight: 3200,
        windowStart: 2000,
        scrollMargin: 40,
        windowHeight: 800,
        followTail: false,
      })
    ).toBe(2000);
    expect(
      scrollTopToRevealVirtualWindow({
        scrollTop: 0,
        viewportHeight: 600,
        scrollHeight: 5000,
        windowStart: 48,
        scrollMargin: 40,
        windowHeight: 400,
        followTail: false,
      })
    ).toBeNull();
    expect(
      scrollTopToRevealVirtualWindow({
        scrollTop: 1600,
        viewportHeight: 400,
        scrollHeight: 2000,
        windowStart: 1100,
        scrollMargin: 0,
        windowHeight: 900,
        followTail: true,
      })
    ).toBeNull();
  });

  it('pulls a followed tail down when the live turn hangs below the fold', () => {
    expect(
      scrollTopToRevealVirtualWindow({
        scrollTop: 1000,
        viewportHeight: 400,
        scrollHeight: 2000,
        windowStart: 1100,
        scrollMargin: 0,
        windowHeight: 900,
        followTail: true,
      })
    ).toBe(1600);
  });

  it('remeasures only the mounted rows of this list', () => {
    const list = document.createElement('div');
    const windowEl = document.createElement('div');
    const tall = document.createElement('div');
    tall.setAttribute('data-index', '2');
    Object.defineProperty(tall, 'offsetHeight', { value: 420 });
    const hidden = document.createElement('div');
    hidden.setAttribute('data-index', '3');
    Object.defineProperty(hidden, 'offsetHeight', { value: 1 });
    const nested = document.createElement('div');
    nested.setAttribute('data-index', '0');
    Object.defineProperty(nested, 'offsetHeight', { value: 900 });
    tall.append(nested);
    windowEl.append(tall, hidden);
    list.append(windowEl);

    const sizes: Array<[number, number]> = [];
    remeasureMountedVirtualRows(list, (index, size) => {
      sizes.push([index, size]);
    });
    expect(sizes).toEqual([[2, 420]]);
  });

  it('keeps the viewport on the same rows when older history is prepended', () => {
    expect(
      scrollTopAfterPrepend({
        followTail: false,
        sessionChanged: false,
        prepended: true,
        previousTotalSize: 2000,
        nextTotalSize: 2800,
        scrollTop: 640,
      })
    ).toBe(1440);
  });

  it('does not shift scroll while the open path is following the tail', () => {
    expect(
      scrollTopAfterPrepend({
        followTail: true,
        sessionChanged: false,
        prepended: true,
        previousTotalSize: 2000,
        nextTotalSize: 2800,
        scrollTop: 1960,
      })
    ).toBe(1960);
  });
});

describe('conversation virtualizer layout coordinates', () => {
  it('measures the list offset without mixing canvas zoom or scrollTop', () => {
    const canvas = { offsetTop: 80, offsetParent: null };
    const container = { offsetTop: 20, offsetParent: canvas };
    const list = { offsetTop: 32, offsetParent: canvas };

    expect(measureScrollMargin(list, container)).toBe(12);
  });

  it('stays stable when the transcript is scrolled far from the top', () => {
    const canvas = { offsetTop: 80, offsetParent: null };
    const container = { offsetTop: 20, offsetParent: canvas };
    const list = { offsetTop: 32, offsetParent: canvas };

    expect(measureScrollMargin(list, container)).toBe(12);
  });

  it('reads the scroll viewport in layout pixels, not scaled bounding rects', () => {
    expect(
      unscaledElementRect({ clientWidth: 480, clientHeight: 640 })
    ).toEqual({ width: 480, height: 640 });
  });

  it('does not collapse a row that has not laid out yet', () => {
    const element = document.createElement('div');
    element.setAttribute('data-index', '4');
    expect(
      measureUnscaledBlockHeight(element, undefined, {
        measurementsCache: [
          undefined,
          undefined,
          undefined,
          undefined,
          { size: 720 },
        ],
      })
    ).toBe(720);
    expect(measureUnscaledBlockHeight(element)).toBe(
      ESTIMATED_CONVERSATION_ROW_HEIGHT
    );
    Object.defineProperty(element, 'offsetHeight', { value: 1 });
    expect(
      measureUnscaledBlockHeight(element, undefined, {
        measurementsCache: [
          undefined,
          undefined,
          undefined,
          undefined,
          { size: 720 },
        ],
      })
    ).toBe(720);
  });

  it('scrolls to a nav target twice so dynamic heights can be measured', () => {
    const calls: number[] = [];
    const scheduled: Array<() => void> = [];
    scheduleMeasuredScrollToIndex(
      (index) => calls.push(index),
      9,
      (callback) => scheduled.push(callback)
    );
    expect(calls).toEqual([9]);
    scheduled.forEach((callback) => callback());
    expect(calls).toEqual([9, 9]);
  });

  it('leaves a gap above a start-aligned user message', () => {
    expect(startAlignedVirtualOffset(0)).toBe(0);
    expect(startAlignedVirtualOffset(12)).toBe(0);
    expect(startAlignedVirtualOffset(400)).toBe(388);
  });
});

describe('pendingAgentPermissionsFromEvents', () => {
  it('keeps permission requests pending until a response event arrives', () => {
    const requested = {
      sequence: 1,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: '2026-06-11T00:00:01.000Z',
      event: {
        kind: 'permission_requested' as const,
        request: {
          id: 'permission-1',
          session_id: 'session',
          title: 'Run tests',
          options: [{ id: 'allow', label: 'Allow once' }],
        },
      },
    };

    expect(pendingAgentPermissionsFromEvents([requested])).toEqual([
      {
        connectionId: 'connection',
        request: requested.event.request,
      },
    ]);

    expect(
      pendingAgentPermissionsFromEvents([
        requested,
        {
          sequence: 2,
          workspace_id: 'workspace',
          connection_id: 'connection',
          session_id: 'session',
          created_at: '2026-06-11T00:00:02.000Z',
          event: {
            kind: 'permission_responded',
            permission_id: 'permission-1',
            response: { kind: 'selected', option_id: 'allow' },
          },
        },
      ])
    ).toEqual([]);
  });

  it('merges snapshot permissions when request events are no longer in the window', () => {
    expect(
      pendingAgentPermissionsForSession(
        [],
        {
          'permission-1': {
            id: 'permission-1',
            session_id: 'session',
            title: 'Run tests',
            options: [{ id: 'allow', label: 'Allow once' }],
          },
          'permission-2': {
            id: 'permission-2',
            session_id: 'other-session',
            title: 'Edit file',
            options: [{ id: 'reject', label: 'Reject' }],
          },
        },
        'session',
        'connection'
      )
    ).toEqual([
      {
        connectionId: 'connection',
        request: {
          id: 'permission-1',
          session_id: 'session',
          title: 'Run tests',
          options: [{ id: 'allow', label: 'Allow once' }],
        },
      },
    ]);
  });
});
