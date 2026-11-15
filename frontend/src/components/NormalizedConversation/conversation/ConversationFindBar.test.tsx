import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationGlobalSearchHit } from '@/features/conversation/conversationApi';
import {
  CONVERSATION_SCROLL_TO_QUOTE_EVENT,
  consumePendingConversationJump,
  type ConversationScrollToQuoteDetail,
} from '@/lib/conversationScroll';
import { ConversationFindBar } from './ConversationFindBar';

describe('ConversationFindBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('supports local in-conversation navigation and expand-to-global FTS5 search with safe <mark> snippets, 20/page pagination, and row-level jump', async () => {
    const page0Hits: ConversationGlobalSearchHit[] = Array.from(
      { length: 21 },
      (_, idx) => ({
        conversation_id: `conv-${idx + 1}`,
        workspace_id: 'ws-1',
        title: idx === 0 ? 'Refactor Auth Module' : `Session ${idx + 1}`,
        snippet:
          idx === 0
            ? 'Updated <mark>token refresh</mark> with <script>alert(1)</script> safety'
            : `Matched <mark>token</mark> in item ${idx + 1}`,
        matchSource: idx === 0 ? 'both' : 'body',
        matchedRowId: `row-${idx + 1}`,
        matchedTurnOrdinal: idx + 3,
      })
    );

    const page1Hits: ConversationGlobalSearchHit[] = [
      {
        conversation_id: 'conv-21',
        workspace_id: 'ws-1',
        title: 'Page Two Hit',
        snippet: 'Second page <mark>token</mark> match',
        matchSource: 'title',
        matchedRowId: 'row-21',
        matchedTurnOrdinal: 8,
      },
    ];

    const searchGlobal = vi.fn(
      async ({ offset }: { offset: number }) =>
        offset === 0 ? page0Hits : page1Hits
    );
    const onSelectGlobalHit = vi.fn();
    const onNext = vi.fn();

    const scrollEvents: ConversationScrollToQuoteDetail[] = [];
    const onScrollEvent = (event: Event) => {
      scrollEvents.push(
        (event as CustomEvent<ConversationScrollToQuoteDetail>).detail
      );
    };
    window.addEventListener(CONVERSATION_SCROLL_TO_QUOTE_EVENT, onScrollEvent);

    try {
      render(
        <ConversationFindBar
          query="token"
          current={1}
          total={3}
          workspaceId="ws-1"
          onQueryChange={vi.fn()}
          onNext={onNext}
          onPrevious={vi.fn()}
          onClose={vi.fn()}
          searchGlobal={searchGlobal}
          onSelectGlobalHit={onSelectGlobalHit}
        />
      );

      // Local mode initially
      const input = screen.getByTestId(
        'conversation-find-input'
      ) as HTMLInputElement;
      expect(input.placeholder).not.toContain('prefix*');

      // Toggle global FTS5 search
      fireEvent.click(screen.getByTestId('find-bar-expand-global'));
      expect(input.placeholder).toContain('prefix*');

      await act(async () => {
        vi.advanceTimersByTime(150);
      });

      expect(searchGlobal).toHaveBeenCalledWith({
        query: 'token',
        workspaceId: 'ws-1',
        limit: 21,
        offset: 0,
      });

      // Renders 20 items on page 1 and keeps <script> literal while rendering <mark>
      const snippet0 = screen.getByTestId('find-hit-snippet-0');
      expect(snippet0.querySelectorAll('mark')).toHaveLength(1);
      expect(snippet0.querySelector('mark')).toHaveTextContent('token refresh');
      expect(snippet0.querySelector('script')).toBeNull();
      expect(snippet0).toHaveTextContent('<script>alert(1)</script>');

      expect(screen.getByTestId('find-hit-turn-0')).toHaveTextContent('3');
      expect(screen.getByTestId('find-hit-source-0')).toBeInTheDocument();
      expect(screen.queryByTestId('find-bar-global-hit-20')).toBeNull();

      // Advance to page 2 (offset 20)
      fireEvent.click(screen.getByTestId('find-bar-next-page'));
      await act(async () => {
        vi.advanceTimersByTime(150);
      });

      expect(searchGlobal).toHaveBeenLastCalledWith({
        query: 'token',
        workspaceId: 'ws-1',
        limit: 21,
        offset: 20,
      });
      expect(screen.getByTestId('find-bar-global-hit-0')).toHaveTextContent(
        'Page Two Hit'
      );

      // Clicking a hit triggers navigation + row-level scroll/pulse event
      fireEvent.click(screen.getByTestId('find-bar-global-hit-0'));
      expect(onSelectGlobalHit).toHaveBeenCalledWith(page1Hits[0]);
      expect(scrollEvents).toHaveLength(1);
      expect(scrollEvents[0]).toMatchObject({
        conversationId: 'conv-21',
        messageId: 'row-21',
        turnOrdinal: 8,
        snippet: 'Second page token match',
      });
      expect(consumePendingConversationJump('conv-21')).toMatchObject({
        conversationId: 'conv-21',
        messageId: 'row-21',
        turnOrdinal: 8,
      });
    } finally {
      window.removeEventListener(
        CONVERSATION_SCROLL_TO_QUOTE_EVENT,
        onScrollEvent
      );
    }
  });
});
