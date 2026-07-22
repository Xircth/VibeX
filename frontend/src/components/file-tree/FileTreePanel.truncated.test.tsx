import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/components/ui/toast';

import { FileTreePanel } from './FileTreePanel';
import { fileTreeApi } from '../../lib/api';
import { ConfirmDialog } from '@/components/dialogs';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/components/dialogs', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));

vi.mock('../../lib/api', () => ({
  desktopApi: {
    openPath: vi.fn(),
  },
  fileTreeApi: {
    copyItem: vi.fn(),
    listDirectoryChildren: vi.fn(),
    saveFile: vi.fn(),
    trashItem: vi.fn(),
  },
}));

describe('FileTreePanel truncated root scans', () => {
  function renderTree(element: ReactElement) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    return render(
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    );
  }

  beforeEach(() => {
    vi.mocked(toast.error).mockReset();
    vi.mocked(fileTreeApi.copyItem).mockReset();
    vi.mocked(fileTreeApi.listDirectoryChildren).mockReset();
    vi.mocked(fileTreeApi.saveFile).mockReset();
    vi.mocked(fileTreeApi.trashItem).mockReset();
    vi.mocked(ConfirmDialog.show).mockReset();
    vi.mocked(fileTreeApi.listDirectoryChildren).mockResolvedValue({
      files: ['src/index.ts'],
      directories: [],
      gitignored_files: [],
      gitignored_directories: [],
      truncated: false,
    });
  });

  it('lazy loads ordinary directories when the root scan was truncated', async () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
        lazyLoadAllDirectories
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /src/i }));

    await waitFor(() => {
      expect(fileTreeApi.listDirectoryChildren).toHaveBeenCalledWith(
        '/repo',
        'src'
      );
    });
  });

  it('does not lazy load ordinary directories after a complete root scan', () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /src/i }));

    expect(fileTreeApi.listDirectoryChildren).not.toHaveBeenCalled();
  });

  it('shows a readable duplicate failure toast from the file context menu', async () => {
    vi.mocked(fileTreeApi.copyItem).mockRejectedValue(new Error('copy failed'));

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['index.ts']}
        directories={[]}
        isLoading={false}
      />
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: /index\.ts/i }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: '复制' }));
    fireEvent.click(screen.getByRole('button', { name: '创建副本' }));

    await waitFor(() => {
      expect(fileTreeApi.copyItem).toHaveBeenCalledWith('/repo/index.ts');
      expect(toast.error).toHaveBeenCalledWith('创建副本失败');
    });
  });

  it('shows a readable create-file failure toast from the inline input', async () => {
    vi.mocked(fileTreeApi.saveFile).mockRejectedValue(new Error('save failed'));

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={[]}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '新建文件' }));
    const input = screen.getByPlaceholderText('untitled');
    fireEvent.change(input, { target: { value: 'broken.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(fileTreeApi.saveFile).toHaveBeenCalledWith('/repo/broken.ts', '');
      expect(toast.error).toHaveBeenCalledWith('创建文件失败');
    });
  });

  it('shows a readable delete failure toast after confirmation', async () => {
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
    vi.mocked(fileTreeApi.trashItem).mockRejectedValue(
      new Error('delete failed')
    );

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['index.ts']}
        directories={[]}
        isLoading={false}
      />
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: /index\.ts/i }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(ConfirmDialog.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '删除',
          message: '确定要删除文件“index.ts”吗？',
        })
      );
      expect(fileTreeApi.trashItem).toHaveBeenCalledWith('/repo/index.ts');
      expect(toast.error).toHaveBeenCalledWith('删除失败');
    });
  });
});
