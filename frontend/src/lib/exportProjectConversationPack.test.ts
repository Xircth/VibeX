import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  exportMarkdown,
  pickHostDirectory,
  writeTextFile,
  join,
  toastSuccess,
  toastError,
  getBackendTransport,
} = vi.hoisted(() => ({
  exportMarkdown: vi.fn(),
  pickHostDirectory: vi.fn(),
  writeTextFile: vi.fn(),
  join: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  getBackendTransport: vi.fn(),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { exportMarkdown },
}));
vi.mock('@/lib/hostFs', () => ({ pickHostDirectory }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile }));
vi.mock('@tauri-apps/api/path', () => ({ join }));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: toastSuccess, error: toastError },
}));
vi.mock('@/lib/transport', () => ({ getBackendTransport }));
vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}));

import { exportProjectConversationPack } from './exportProjectConversationPack';

describe('exportProjectConversationPack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exportMarkdown.mockImplementation(async (id: string) => `# ${id}`);
    pickHostDirectory.mockResolvedValue('/tmp/pack');
    join.mockImplementation(
      async (dir: string, name: string) => `${dir}/${name}`
    );
    writeTextFile.mockResolvedValue(undefined);
    getBackendTransport.mockReturnValue({ environment: 'desktop' });
  });

  it('writes one markdown file per session into the chosen folder', async () => {
    await exportProjectConversationPack([
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ]);

    expect(writeTextFile).toHaveBeenCalledWith('/tmp/pack/Alpha.md', '# a');
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/pack/Beta.md', '# b');
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('does not write when the folder picker is cancelled', async () => {
    pickHostDirectory.mockResolvedValue(null);
    await exportProjectConversationPack([{ id: 'a', title: 'Alpha' }]);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('toasts when there are no sessions', async () => {
    await exportProjectConversationPack([]);
    expect(toastError).toHaveBeenCalled();
    expect(pickHostDirectory).not.toHaveBeenCalled();
  });
});
