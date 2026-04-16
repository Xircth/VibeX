import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { TaskFormDialog } from './TaskFormDialog';

vi.mock('@ebay/nice-modal-react', () => {
  const create = (component: unknown) => component;
  return {
    __esModule: true,
    default: { create },
    create,
    useModal: () => ({
      visible: true,
      hide: vi.fn(),
      remove: vi.fn(),
      resolve: vi.fn(),
    }),
  };
});

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    system: {
      config: {
        executor_profile: {
          executor: BaseCodingAgent.CODEX,
          variant: null,
        },
      },
    },
    profiles: {
      executors: [],
    },
    loading: false,
  }),
}));

vi.mock('@/hooks', () => ({
  useTaskImages: () => ({ data: [] }),
  useImageUpload: () => ({
    upload: vi.fn(),
    uploadForTask: vi.fn(),
    deleteImage: vi.fn(),
  }),
  useTaskMutations: () => ({
    createAndStart: { mutateAsync: vi.fn() },
    updateTask: { mutateAsync: vi.fn() },
  }),
  useProjectRepos: () => ({
    data: [{ id: 'repo-1', name: 'repo', display_name: 'repo', path: '/repo' }],
  }),
  useRepoBranchSelection: () => ({
    configs: [
      {
        repoId: 'repo-1',
        branches: ['main'],
        targetBranch: 'main',
      },
    ],
    isLoading: false,
  }),
}));

vi.mock('react-hotkeys-hook', () => ({
  useHotkeysContext: () => ({
    enableScope: vi.fn(),
    disableScope: vi.fn(),
  }),
}));

vi.mock('@/keyboard', () => ({
  Scope: {
    DIALOG: 'dialog',
    CONFIRMATION: 'confirmation',
  },
  useKeySubmit: vi.fn(),
  useKeySubmitTask: vi.fn(),
  useKeyExit: vi.fn(),
}));

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

vi.mock('@/components/tasks/TerminalProfileControls', () => ({
  TerminalProfileControls: () => <div data-testid="profile-controls" />,
}));

vi.mock('@/components/tasks/BranchSelector', () => ({
  default: () => <div data-testid="branch-selector" />,
}));

vi.mock('@/components/tasks/RepoBranchSelector', () => ({
  default: () => <div data-testid="repo-branch-selector" />,
}));

describe('TaskFormDialog', () => {
  it('shows tag and slash typeahead in the description editor', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <TaskFormDialog mode="create" projectId="project-1" />
      </QueryClientProvider>
    );

    const editor = screen.getByLabelText('Markdown editor');

    await user.click(editor);
    await user.keyboard('#');

    await waitFor(() => {
      expect(screen.getByText('Tags')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');
    await user.keyboard('/');

    await waitFor(() => {
      expect(screen.getByText('Commands')).toBeInTheDocument();
    });
  });
});
