import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSelectionToolbar } from './ConversationSelectionToolbar';
import { formatQuoteToken } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

const writeClipboard = vi.hoisted(() => vi.fn(async () => true));
const insertToken = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: writeClipboard,
}));

vi.mock('@/lib/composerInsert', () => ({
  requestComposerTokenInsert: insertToken,
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

describe('ConversationSelectionToolbar', () => {
  beforeEach(() => {
    insertToken.mockClear();
    writeClipboard.mockClear();
  });

  it('quotes and copies the selected conversation text', async () => {
    const rootRef = createRef<HTMLDivElement>();
    render(
      <div>
        <div ref={rootRef}>
          <p>请你帮我完成这次修改</p>
        </div>
        <ConversationSelectionToolbar
          rootRef={rootRef}
          conversationId="conv-quote-source"
        />
      </div>
    );

    const message = screen.getByText('请你帮我完成这次修改');
    const range = document.createRange();
    range.selectNodeContents(message);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(message);

    const quote = await screen.findByRole('button', { name: '引用' });
    expect(screen.getByRole('button', { name: '复制文本' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '提问' })).toBeNull();

    fireEvent.click(quote);
    expect(insertToken).toHaveBeenCalledWith({
      value: formatQuoteToken('请你帮我完成这次修改'),
      label: '@请你帮我...',
      conversationId: 'conv-quote-source',
    });
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).toBeNull();
    });

    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(message);
    fireEvent.click(await screen.findByRole('button', { name: '复制文本' }));
    expect(writeClipboard).toHaveBeenCalledWith('请你帮我完成这次修改');
  });

  it('quotes selected markdown instead of flattened text', async () => {
    const rootRef = createRef<HTMLDivElement>();
    render(
      <div>
        <div ref={rootRef}>
          <p>
            Use <strong>bold</strong> and <code>code</code>
          </p>
        </div>
        <ConversationSelectionToolbar
          rootRef={rootRef}
          conversationId="conv-quote-source"
        />
      </div>
    );

    const message = screen.getByText('Use', { exact: false });
    const range = document.createRange();
    range.selectNodeContents(message);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(message);

    fireEvent.click(await screen.findByRole('button', { name: '引用' }));
    expect(insertToken).toHaveBeenCalledWith({
      value: formatQuoteToken('Use **bold** and `code`'),
      label: '@Use ...',
      conversationId: 'conv-quote-source',
    });
  });

  it('captures turn/message/block anchor metadata and attaches inline annotations', async () => {
    const { getSessionComposerStructuredTokens } = await import(
      '@/components/tasks/follow-up/sessionComposerStructuredTokens'
    );
    const rootRef = createRef<HTMLDivElement>();
    render(
      <div>
        <div ref={rootRef}>
          <div
            data-turn-id="turn-9"
            data-message-id="turn-9:assistant"
            data-block-index="1"
          >
            <p>
              {' '}
              Prefix context:<span>validate token expiry</span> after refresh
            </p>
          </div>
        </div>
        <ConversationSelectionToolbar
          rootRef={rootRef}
          conversationId="conv-anchor-9"
        />
      </div>
    );

    const target = screen.getByText('validate token expiry');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(target);

    const annotateBtn = await screen.findByTestId(
      'conversation-selection-annotate'
    );
    fireEvent.click(annotateBtn);

    const input = await screen.findByTestId(
      'conversation-selection-annotation-input'
    );
    fireEvent.change(input, {
      target: { value: 'handle clock skew gracefully' },
    });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(insertToken).toHaveBeenCalledTimes(1);
    const insertedArg = (
      insertToken.mock.calls as unknown as Array<[{ value: string }]>
    )[0]?.[0];
    const [parsed] = getSessionComposerStructuredTokens(
      insertedArg?.value ?? ''
    );
    expect(parsed).toMatchObject({
      kind: 'quote',
      value: 'validate token expiry',
      quote: {
        conversationId: 'conv-anchor-9',
        turnId: 'turn-9',
        messageId: 'turn-9:assistant',
        blockIndex: 1,
        annotation: 'handle clock skew gracefully',
      },
    });
  });
});
