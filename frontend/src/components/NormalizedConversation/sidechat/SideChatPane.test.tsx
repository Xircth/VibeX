import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MessageTurn } from 'shared/types';
import {
  COMPOSER_INSERT_EVENT,
  type ComposerInsertDetail,
} from '@/lib/composerInsert';
import { SideChatPane } from './SideChatPane';
import {
  extractRecentMainThreadTurns,
  type SideChatClient,
} from './sideChatClient';

vi.mock('../AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="side-chat-markdown">{value}</div>
  ),
}));

function makeTurn(
  id: string,
  role: 'user' | 'assistant',
  text: string
): MessageTurn {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

const SAMPLE_TURNS: MessageTurn[] = [
  makeTurn('u1', 'user', 'Turn 1 user question'),
  makeTurn('a1', 'assistant', 'Turn 1 assistant reply'),
  makeTurn('u2', 'user', 'Turn 2 user question'),
  makeTurn('a2', 'assistant', 'Turn 2 assistant reply'),
  makeTurn('u3', 'user', 'Turn 3 user question'),
  makeTurn('a3', 'assistant', 'Turn 3 assistant reply'),
  makeTurn('u4', 'user', 'Turn 4 user question'),
  makeTurn('a4', 'assistant', 'Turn 4 assistant reply'),
];

describe('extractRecentMainThreadTurns', () => {
  it('packages at most the last 3 main-thread exchanges without mutating input', () => {
    const frozen = Object.freeze([...SAMPLE_TURNS]);
    const extracted = extractRecentMainThreadTurns(frozen, 3);

    expect(extracted).toHaveLength(3);
    expect(extracted.map((t) => t.turnNumber)).toEqual([2, 3, 4]);
    expect(extracted[0].userText).toBe('Turn 2 user question');
    expect(extracted[2].assistantText).toBe('Turn 4 assistant reply');
  });
});

describe('SideChatPane', () => {
  it('toggles open and closed via Ctrl+Shift+S and discards ephemeral state on close', async () => {
    const sendSideChatPrompt = vi.fn().mockResolvedValue({
      content: 'Temporary answer that will be discarded.',
    });
    const mockClient: SideChatClient = {
      sendSideChatPrompt,
      abortSideChat: vi.fn().mockResolvedValue(undefined),
    };

    render(
      <SideChatPane
        conversationId="conv-100"
        turns={SAMPLE_TURNS}
        client={mockClient}
      />
    );

    expect(screen.queryByTestId('side-chat-pane')).toBeNull();

    fireEvent.keyDown(window, {
      key: 'S',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(await screen.findByTestId('side-chat-pane')).toBeInTheDocument();
    expect(screen.getByTestId('side-chat-context-badge')).toHaveTextContent(
      '3'
    );

    const input = screen.getByTestId('side-chat-input');
    fireEvent.change(input, { target: { value: 'Quick check?' } });
    fireEvent.click(screen.getByTestId('side-chat-send'));

    await waitFor(() => {
      expect(screen.getByTestId('side-chat-markdown')).toHaveTextContent(
        'Temporary answer that will be discarded.'
      );
    });

    expect(sendSideChatPrompt).toHaveBeenCalledTimes(1);
    expect(sendSideChatPrompt.mock.calls[0][0].contextTurns).toHaveLength(3);

    fireEvent.click(screen.getByTestId('side-chat-discard'));
    expect(screen.queryByTestId('side-chat-pane')).toBeNull();

    // Reopen via Ctrl+Shift+S — previous ephemeral messages must be gone
    fireEvent.keyDown(window, {
      key: 's',
      ctrlKey: true,
      shiftKey: true,
    });

    expect(await screen.findByTestId('side-chat-pane')).toBeInTheDocument();
    expect(screen.queryByTestId('side-chat-markdown')).toBeNull();
  });

  it('merges conclusion back as a structured quote token into the main composer draft and closes', async () => {
    const mockClient: SideChatClient = {
      sendSideChatPrompt: vi.fn().mockImplementation(async (req) => {
        req.onEvent?.({
          type: 'tool',
          toolCall: {
            id: 'tc-1',
            name: 'read_file',
            status: 'completed',
            summary: 'src/config.ts',
          },
        });
        return {
          content: 'Use `configuredBackendTransport` for IPC compatibility.',
        };
      }),
      abortSideChat: vi.fn().mockResolvedValue(undefined),
    };

    const insertEvents: ComposerInsertDetail[] = [];
    const onInsert = (event: Event) => {
      insertEvents.push((event as CustomEvent<ComposerInsertDetail>).detail);
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);

    const onMergeBack = vi.fn();

    try {
      render(
        <SideChatPane
          conversationId="conv-merge-1"
          turns={SAMPLE_TURNS}
          client={mockClient}
          defaultOpen
          onMergeBack={onMergeBack}
        />
      );

      const mergeBtn = screen.getByTestId('side-chat-merge-back');
      expect(mergeBtn).toBeDisabled();

      const input = screen.getByTestId('side-chat-input');
      fireEvent.change(input, {
        target: { value: 'Which transport should SideChat use?' },
      });
      fireEvent.click(screen.getByTestId('side-chat-send'));

      await waitFor(() => {
        expect(screen.getByTestId('side-chat-markdown')).toHaveTextContent(
          'Use `configuredBackendTransport` for IPC compatibility.'
        );
      });

      expect(screen.getByTestId('side-chat-tool-list')).toHaveTextContent(
        'read_file'
      );
      expect(mergeBtn).not.toBeDisabled();

      fireEvent.click(mergeBtn);

      expect(screen.queryByTestId('side-chat-pane')).toBeNull();
      expect(onMergeBack).toHaveBeenCalledTimes(1);
      expect(onMergeBack.mock.calls[0][0]).toMatchObject({
        userQuestion: 'Which transport should SideChat use?',
        assistantAnswer:
          'Use `configuredBackendTransport` for IPC compatibility.',
      });

      expect(insertEvents).toHaveLength(1);
      expect(insertEvents[0].mode).toBe('token');
      expect(insertEvents[0].conversationId).toBe('conv-merge-1');
      expect(insertEvents[0].text).toContain('[:quote]');
      expect(insertEvents[0].text).toContain(
        'Which transport should SideChat use?'
      );
      expect(insertEvents[0].text).toContain(
        'Use `configuredBackendTransport` for IPC compatibility.'
      );
    } finally {
      window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
    }
  });
});
