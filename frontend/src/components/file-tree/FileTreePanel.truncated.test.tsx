import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTreePanel } from './FileTreePanel';
import { fileTreeApi } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  desktopApi: {
    openPath: vi.fn(),
  },
  fileTreeApi: {
    listDirectoryChildren: vi.fn(),
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
    vi.mocked(fileTreeApi.listDirectoryChildren).mockReset();
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
});
