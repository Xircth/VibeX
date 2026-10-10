import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileTreeApi } from '@/lib/api';
import { fileContentKeys, useFileContent, useSaveFile } from './useFileContent';

vi.mock('@/lib/api', () => ({
  fileTreeApi: { readFile: vi.fn(), saveFile: vi.fn() },
}));

describe('saved file content', () => {
  beforeEach(() => {
    vi.mocked(fileTreeApi.saveFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fileTreeApi.readFile).mockReset();
  });

  it('shows saved Markdown immediately while the filesystem refresh is pending', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const path = '/workspace/README.md';
    queryClient.setQueryData(fileContentKeys.byPath(path), '# Original');
    vi.mocked(fileTreeApi.readFile).mockReturnValue(new Promise(() => {}));
    const { result, unmount } = renderHook(
      () => ({ file: useFileContent(path), save: useSaveFile() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      }
    );

    await act(async () => {
      await result.current.save.mutateAsync({ path, content: '# Saved' });
    });

    await waitFor(() => expect(result.current.file.data).toBe('# Saved'));
    unmount();
    queryClient.clear();
  });
});
