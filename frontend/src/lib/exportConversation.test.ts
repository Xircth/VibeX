import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  save,
  writeTextFile,
  exportMarkdown,
  exportHtml,
  toastSuccess,
  getBackendTransport,
} = vi.hoisted(() => ({
  save: vi.fn(),
  writeTextFile: vi.fn(),
  exportMarkdown: vi.fn(),
  exportHtml: vi.fn(),
  toastSuccess: vi.fn(),
  getBackendTransport: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile }));
vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    exportMarkdown,
    exportHtml,
  },
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));
vi.mock('@/lib/transport', () => ({ getBackendTransport }));
vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}));

import { exportConversation } from './exportConversation';

describe('exportConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exportMarkdown.mockResolvedValue('# Hello');
    exportHtml.mockResolvedValue('<h1>Hello</h1>');
    document.body.replaceChildren();
  });

  it('saves through the native dialog on the local desktop Host', async () => {
    getBackendTransport.mockReturnValue({ environment: 'desktop' });
    save.mockResolvedValue('/tmp/conversation.md');
    writeTextFile.mockResolvedValue(undefined);

    await exportConversation('conv-1', 'markdown', 'My / Talk');

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'My___Talk.md' })
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      '/tmp/conversation.md',
      '# Hello'
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('does not write when the desktop save dialog is cancelled', async () => {
    getBackendTransport.mockReturnValue({ environment: 'desktop' });
    save.mockResolvedValue(null);

    await exportConversation('conv-1', 'markdown');

    expect(writeTextFile).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each(['web', 'remote-desktop'] as const)(
    'downloads a blob in the %s environment',
    async (environment) => {
      getBackendTransport.mockReturnValue({ environment });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);
      const createObjectURL = vi.fn(() => 'blob:conversation');
      const revokeObjectURL = vi.fn();
      Object.assign(URL, { createObjectURL, revokeObjectURL });

      await exportConversation('conv-1', 'html', '');

      expect(save).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
      expect(createObjectURL).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalled();
      expect(toastSuccess).toHaveBeenCalled();
    }
  );
});
