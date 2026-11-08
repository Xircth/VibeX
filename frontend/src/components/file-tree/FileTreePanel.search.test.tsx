import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextMenuHost } from '@/components/context-menu';
import { FileTreePanel } from './FileTreePanel';
import { fileTreeApi } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  desktopApi: {
    openPath: vi.fn(),
    revealInFileManager: vi.fn(),
  },
  fileTreeApi: {
    copyItem: vi.fn(),
    createDirectory: vi.fn(),
    getTree: vi.fn(),
    listDirectoryChildren: vi.fn(),
    moveItem: vi.fn(),
    saveFile: vi.fn(),
    searchText: vi.fn(),
    trashItem: vi.fn(),
  },
}));

function renderTree(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppContextMenuHost>{element}</AppContextMenuHost>
    </QueryClientProvider>
  );
}

function openSearchOptions() {
  fireEvent.click(screen.getByRole('button', { name: '搜索选项' }));
}

function openSearchFromMoreMenu(itemLabel: '搜索文件内容' | '搜索文件名称') {
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  fireEvent.mouseEnter(screen.getByRole('button', { name: '搜索' }));
  fireEvent.click(screen.getByRole('button', { name: itemLabel }));
}

describe('FileTreePanel workspace search', () => {
  beforeEach(() => {
    vi.mocked(fileTreeApi.getTree).mockReset();
    vi.mocked(fileTreeApi.getTree).mockResolvedValue([
      {
        name: 'readme.md',
        path: 'readme.md',
        is_dir: false,
        children: null,
        git_status: null,
      },
      {
        name: 'src',
        path: 'src',
        is_dir: true,
        children: [
          {
            name: 'App.tsx',
            path: 'src/App.tsx',
            is_dir: false,
            children: null,
            git_status: null,
          },
        ],
        git_status: null,
      },
    ]);
    vi.mocked(fileTreeApi.searchText).mockReset();
    vi.mocked(fileTreeApi.searchText).mockResolvedValue({
      files: [
        {
          path: 'readme.md',
          match_count: 1000,
          matches: [
            {
              line: 2,
              column: 1,
              end_column: 4,
              preview: 'hello',
            },
          ],
        },
      ],
      file_count: 134,
      total_matches: 1000,
      truncated: true,
    });
  });

  it('replaces the tree while a content query is present and closes from blank space', async () => {
    const { container } = renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['readme.md']}
        directories={[]}
        isLoading={false}
      />
    );

    expect(
      screen.getByRole('button', { name: 'readme.md' })
    ).toBeInTheDocument();
    openSearchFromMoreMenu('搜索文件内容');

    const input = screen.getByRole('textbox', { name: '搜索文件内容...' });
    expect(input).toBeInTheDocument();
    const field = container.querySelector('.file-tree-search-field');
    const inputControl = field?.querySelector('.astryx-text-input');
    const optionsButton = screen.getByRole('button', { name: '搜索选项' });
    expect(inputControl).not.toBeNull();
    expect(field?.querySelector('.astryx-power-search')).toBeNull();
    expect(inputControl?.contains(optionsButton)).toBe(false);
    expect(field?.contains(optionsButton)).toBe(true);
    expect(input.closest('.astryx-field')?.parentElement).toBe(field);
    expect(field?.lastElementChild).toBe(optionsButton);
    expect(optionsButton).toHaveClass('file-tree-search-options');
    expect(
      screen.queryByRole('button', { name: '区分大小写' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('包含的文件 (如: *.ts, src/**)')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '更多选项' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: '新建文件' })
    ).not.toBeInTheDocument();

    openSearchOptions();
    for (const name of ['区分大小写', '全词匹配', '正则表达式']) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toBeVisible();
      expect(item.querySelector('svg')).not.toBeNull();
    }
    expect(screen.queryByRole('menuitem', { name: '更多选项' })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: '区分大小写' }));

    fireEvent.change(input, { target: { value: 'hello' } });

    await waitFor(() => {
      expect(screen.getByTestId('search-result-summary')).toHaveAttribute(
        'aria-label',
        '134 个文件，1000 个匹配'
      );
      expect(fileTreeApi.searchText).toHaveBeenCalledWith(
        '/repo',
        expect.objectContaining({
          query: 'hello',
          case_sensitive: true,
          whole_word: false,
          is_regex: false,
        })
      );
    });
    expect(screen.getByText('134 个文件')).toBeInTheDocument();
    expect(screen.getByText('1000 个匹配')).toBeInTheDocument();
    expect(screen.getByTestId('search-result-limit')).toHaveTextContent(
      '结果过多，仅显示部分匹配'
    );
    expect(
      screen.queryByRole('button', { name: 'readme.md' })
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('.file-tree-search-results')
    ).not.toHaveClass('border-b');

    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'readme.md' })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('textbox', { name: '搜索文件内容...' })
    ).toBeInTheDocument();

    const list = container.querySelector('.file-tree-list');
    expect(list).not.toBeNull();
    fireEvent.pointerDown(list!);

    expect(
      screen.queryByRole('textbox', { name: '搜索文件内容...' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '更多操作' })
    ).toBeInTheDocument();
  });

  it('supports searching file names from the 3-dot menu and opens the clicked file', async () => {
    const onOpenFile = vi.fn();
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['readme.md', 'src/App.tsx']}
        directories={['src']}
        isLoading={false}
        onOpenFile={onOpenFile}
      />
    );

    openSearchFromMoreMenu('搜索文件名称');

    const input = screen.getByRole('textbox', { name: '搜索文件名称...' });
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'App.tsx' } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /src\/App\.tsx/i })
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /src\/App\.tsx/i }));
    expect(onOpenFile).toHaveBeenCalledWith('src/App.tsx', undefined);
  });
});
