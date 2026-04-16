import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import WYSIWYGEditor from '@/components/ui/wysiwyg';

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    commands: [{ name: 'plan', description: 'Start the planning workflow' }],
    discovering: false,
    error: null,
    isConnected: true,
    isInitialized: true,
  }),
}));

vi.mock('@/lib/searchTagsAndFiles', () => ({
  searchTagsAndFiles: vi.fn(
    async (query: string, options?: { includeTags?: boolean }) => {
      if (options?.includeTags) {
        return [
          {
            type: 'tag',
            tag: {
              id: 'tag-1',
              tag_name: query ? `tag-${query}` : 'tag-demo',
              content: 'demo tag',
            },
          },
        ];
      }
      return [];
    }
  ),
}));

describe('WYSIWYGEditor task-form triggers', () => {
  it('opens typeahead menus with task-form style props', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const user = userEvent.setup();
    let value = '';

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <WYSIWYGEditor
          placeholder=""
          value={value}
          onChange={(next) => {
            value = next;
            rerender(
              <QueryClientProvider client={queryClient}>
                <WYSIWYGEditor
                  placeholder=""
                  value={value}
                  onChange={() => {}}
                  repoIds={['repo-1']}
                  projectId="project-1"
                  executorProfile={{
                    executor: BaseCodingAgent.CODEX,
                    variant: null,
                  }}
                  repoId="repo-1"
                  enableFloatingToolbar={false}
                />
              </QueryClientProvider>
            );
          }}
          repoIds={['repo-1']}
          projectId="project-1"
          executorProfile={{
            executor: BaseCodingAgent.CODEX,
            variant: null,
          }}
          repoId="repo-1"
          enableFloatingToolbar={false}
        />
      </QueryClientProvider>
    );

    const editor = screen.getByLabelText('Markdown editor');
    await user.click(editor);
    await user.keyboard('/');

    await waitFor(() => {
      expect(screen.getByText('Commands')).toBeInTheDocument();
    });
  });
});
