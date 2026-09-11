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
        <ConversationSelectionToolbar rootRef={rootRef} />
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
        <ConversationSelectionToolbar rootRef={rootRef} />
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
    });
  });
});
