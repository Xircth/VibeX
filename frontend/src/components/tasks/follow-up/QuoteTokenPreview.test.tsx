import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_SCROLL_TO_QUOTE_EVENT,
  pulseQuoteTargetElement,
  requestConversationScrollToQuote,
} from '@/lib/conversationScroll';
import { QuoteTokenPreview } from './QuoteTokenPreview';

describe('QuoteTokenPreview & quote anchor jump', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders existing annotation, triggers source jump, and edits/clears inline notes', () => {
    const anchor = document.createElement('span');
    document.body.appendChild(anchor);

    const onJumpToSource = vi.fn();
    const onUpdateAnnotation = vi.fn();

    render(
      <QuoteTokenPreview
        anchor={anchor}
        text="const user = session.user;"
        quoteMeta={{
          turnId: 'turn-4',
          messageId: 'turn-4:assistant',
          annotation: 'session may be null',
        }}
        onJumpToSource={onJumpToSource}
        onUpdateAnnotation={onUpdateAnnotation}
      />
    );

    expect(screen.getByTestId('quote-token-preview-annotation')).toHaveTextContent(
      'session may be null'
    );

    fireEvent.click(screen.getByTestId('quote-token-jump-source'));
    expect(onJumpToSource).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('quote-token-edit-note'));
    const input = screen.getByTestId('quote-token-note-input');
    fireEvent.change(input, { target: { value: 'guard optional session' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdateAnnotation).toHaveBeenCalledWith('guard optional session');

    fireEvent.click(screen.getByTestId('quote-token-edit-note'));
    fireEvent.click(screen.getByTestId('quote-token-note-clear'));
    expect(onUpdateAnnotation).toHaveBeenCalledWith('');

    anchor.remove();
  });

  it('dispatches quote scroll event and pulses the target turn element', () => {
    vi.useFakeTimers();

    const listener = vi.fn();
    window.addEventListener(CONVERSATION_SCROLL_TO_QUOTE_EVENT, listener);

    requestConversationScrollToQuote({
      conversationId: 'conv-1',
      turnId: 'turn-2',
      messageId: 'turn-2:assistant',
      blockIndex: 0,
      snippet: 'return cachedValue;',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(CONVERSATION_SCROLL_TO_QUOTE_EVENT, listener);

    const container = document.createElement('div');
    const row = document.createElement('div');
    row.dataset.turnId = 'turn-2';
    row.dataset.messageId = 'turn-2:assistant';
    const block = document.createElement('div');
    block.dataset.blockIndex = '0';
    block.textContent = 'return cachedValue;';
    row.appendChild(block);
    container.appendChild(row);

    const pulsed = pulseQuoteTargetElement(container, {
      turnId: 'turn-2',
      messageId: 'turn-2:assistant',
      blockIndex: 0,
    });

    expect(pulsed).toBe(block);
    expect(block.classList.contains('conv-quote-anchor-pulse')).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(block.classList.contains('conv-quote-anchor-pulse')).toBe(false);
  });
});
