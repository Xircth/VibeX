import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesSelectionToolbar } from './NotesSelectionToolbar';
import {
  formatQuoteToken,
  quoteTokenChipLabel,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

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

describe('NotesSelectionToolbar', () => {
  beforeEach(() => {
    insertToken.mockClear();
    writeClipboard.mockClear();
  });

  it('quotes the selected note with the same composer token as a message', async () => {
    const editorRef = createRef<HTMLTextAreaElement>();
    render(
      <>
        <textarea ref={editorRef} defaultValue="在笔记里记下这次修复" />
        <NotesSelectionToolbar editorRef={editorRef} />
      </>
    );

    const editor = editorRef.current;
    expect(editor).toBeTruthy();
    editor!.focus();
    editor!.setSelectionRange(0, 11);
    fireEvent.mouseUp(editor!);

    const quote = await screen.findByRole('button', { name: '引用' });
    fireEvent.click(quote);

    const text = '在笔记里记下这次修复';
    expect(insertToken).toHaveBeenCalledWith({
      value: formatQuoteToken(text),
      label: quoteTokenChipLabel(text),
    });
    await waitFor(() => {
      expect(screen.queryByTestId('notes-selection-toolbar')).toBeNull();
    });
  });
});
