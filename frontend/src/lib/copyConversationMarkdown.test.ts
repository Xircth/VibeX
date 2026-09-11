import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exportMarkdown, writeClipboard, toastSuccess, toastError } = vi.hoisted(
  () => ({
    exportMarkdown: vi.fn(),
    writeClipboard: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  })
);

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { exportMarkdown },
}));
vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: writeClipboard,
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: toastSuccess, error: toastError },
}));
vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}));

import { copyConversationMarkdown } from './copyConversationMarkdown';

describe('copyConversationMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exportMarkdown.mockResolvedValue('# Talk');
    writeClipboard.mockResolvedValue(true);
  });

  it('writes exported markdown to the clipboard', async () => {
    await copyConversationMarkdown('conv-1');
    expect(exportMarkdown).toHaveBeenCalledWith('conv-1');
    expect(writeClipboard).toHaveBeenCalledWith('# Talk');
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('toasts when the clipboard write fails', async () => {
    writeClipboard.mockResolvedValue(false);
    await copyConversationMarkdown('conv-1');
    expect(toastError).toHaveBeenCalled();
  });
});
