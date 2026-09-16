import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/components/ui/toast';

import { FileTreePanel } from './FileTreePanel';
import { FILE_TREE_EXPAND_ALL_CONCURRENCY } from './file-tree-utils';
import { fileTreeApi } from '../../lib/api';
import { ConfirmDialog } from '@/components/dialogs';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import type { DirectoryChildrenResponse } from '../../lib/api';

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
    createDirectory: vi.fn(),
    listDirectoryChildren: vi.fn(),
    saveFile: vi.fn(),
    trashItem: vi.fn(),
  },
}));

describe('FileTreePanel lazy directory loading', () => {
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
    useFileTreeStore.setState({
      rootPath: null,
      selectedFilePath: null,
      expandedByRoot: {},
      lazyListingByRoot: {},
      diffFilePath: null,
      revealTarget: null,
    });
    vi.mocked(toast.error).mockReset();
    vi.mocked(fileTreeApi.copyItem).mockReset();
    vi.mocked(fileTreeApi.createDirectory).mockReset();
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

  it('lazy loads ordinary directories when expanded', async () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
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

  it('keeps expanded folders after the panel remounts on the same workspace', async () => {
    const { unmount } = renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /src/i }));
    await waitFor(() => {
      expect(fileTreeApi.listDirectoryChildren).toHaveBeenCalledWith(
        '/repo',
        'src'
      );
    });

    unmount();
    vi.mocked(fileTreeApi.listDirectoryChildren).mockClear();

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
      />
    );

    await waitFor(() => {
      expect(fileTreeApi.listDirectoryChildren).toHaveBeenCalledWith(
        '/repo',
        'src'
      );
    });
  });

  it('keeps already visible children while a folder listing refreshes', async () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['assets/logo.png']}
        directories={['assets']}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /assets/i }));

    expect(
      screen.getByRole('button', { name: /logo\.png/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fileTreeApi.listDirectoryChildren).toHaveBeenCalledWith(
        '/repo',
        'assets'
      );
    });
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

  it('shows an inline new-file field from a folder context menu', async () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
      />
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: /src/i }));
    const newFileButtons = screen.getAllByRole('button', { name: '新建文件' });
    fireEvent.pointerDown(newFileButtons[newFileButtons.length - 1]);

    expect(screen.getByPlaceholderText('untitled')).toBeInTheDocument();
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

  it('keeps the workspace root expanded and ignores root collapse clicks', () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src', 'docs']}
        isLoading={false}
      />
    );

    expect(screen.getByRole('button', { name: /src/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /docs/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'repo' }));

    expect(screen.getByRole('button', { name: /src/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /docs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'repo' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('expands all folders in bounded batches and then loads nested directories', async () => {
    const folders = ['assets', 'crates', 'docs', 'frontend', 'scripts', 'src'];
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const pending = new Map<
      string,
      {
        resolve: (value: DirectoryChildrenResponse) => void;
      }
    >();

    vi.mocked(fileTreeApi.listDirectoryChildren).mockImplementation(
      (_root, path) => {
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        return new Promise<DirectoryChildrenResponse>((resolve) => {
          pending.set(path, {
            resolve: (value) => {
              pending.delete(path);
              activeLoads -= 1;
              resolve(value);
            },
          });
        });
      }
    );

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={folders}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '展开所有文件夹' }));

    await waitFor(() => {
      expect(pending.size).toBe(FILE_TREE_EXPAND_ALL_CONCURRENCY);
    });
    expect(maxActiveLoads).toBeLessThanOrEqual(
      FILE_TREE_EXPAND_ALL_CONCURRENCY
    );
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
    expect(screen.queryByText('加载失败，点击重试')).not.toBeInTheDocument();

    const firstBatch = Array.from(pending.keys());
    const nestedParent = firstBatch[0]!;
    for (const path of firstBatch) {
      pending.get(path)!.resolve({
        files: path === nestedParent ? [] : [`${path}/readme.md`],
        directories: path === nestedParent ? [`${path}/nested`] : [],
        gitignored_files: [],
        gitignored_directories: [],
        truncated: false,
      });
    }

    await waitFor(() => {
      expect(pending.has(`${nestedParent}/nested`)).toBe(true);
    });
    expect(maxActiveLoads).toBeLessThanOrEqual(
      FILE_TREE_EXPAND_ALL_CONCURRENCY
    );

    pending.get(`${nestedParent}/nested`)!.resolve({
      files: [`${nestedParent}/nested/deep.ts`],
      directories: [],
      gitignored_files: [],
      gitignored_directories: [],
      truncated: false,
    });

    for (const path of folders) {
      pending.get(path)?.resolve({
        files: [`${path}/readme.md`],
        directories: [],
        gitignored_files: [],
        gitignored_directories: [],
        truncated: false,
      });
    }

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /deep\.ts/i })
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
    expect(maxActiveLoads).toBeLessThanOrEqual(
      FILE_TREE_EXPAND_ALL_CONCURRENCY
    );
  });

  it('keeps already visible children while expand-all loads the rest', async () => {
    const pending = new Map<
      string,
      (value: DirectoryChildrenResponse) => void
    >();
    vi.mocked(fileTreeApi.listDirectoryChildren).mockImplementation(
      (_root, path) =>
        new Promise<DirectoryChildrenResponse>((resolve) => {
          pending.set(path, resolve);
        })
    );

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['assets/logo.png']}
        directories={['assets', 'src']}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /assets/i }));
    expect(
      screen.getByRole('button', { name: /logo\.png/i })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开所有文件夹' }));

    await waitFor(() => {
      expect(pending.has('src')).toBe(true);
    });
    expect(
      screen.getByRole('button', { name: /logo\.png/i })
    ).toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();

    pending.get('src')?.({
      files: ['src/index.ts'],
      directories: [],
      gitignored_files: [],
      gitignored_directories: [],
      truncated: false,
    });
    pending.get('assets')?.({
      files: ['assets/logo.png'],
      directories: [],
      gitignored_files: [],
      gitignored_directories: [],
      truncated: false,
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /index\.ts/i })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /logo\.png/i })
    ).toBeInTheDocument();
  });

  it('shows a retry control when expand-all fails and recovers after retry', async () => {
    vi.mocked(fileTreeApi.listDirectoryChildren)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        files: ['src/index.ts'],
        directories: [],
        gitignored_files: [],
        gitignored_directories: [],
        truncated: false,
      });

    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={[]}
        directories={['src']}
        isLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '展开所有文件夹' }));

    const retryButton = await screen.findByRole('button', {
      name: '加载失败，点击重试',
    });
    expect(retryButton).toHaveAttribute('title', 'network down');

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /index\.ts/i })
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('加载失败，点击重试')).not.toBeInTheDocument();
  });
});
