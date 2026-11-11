import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { ProjectQuickSwitcher } from './ProjectQuickSwitcher';

const switchProject = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const openSurfaceMenu = vi.hoisted(() => vi.fn());
const showProjectFormDialog = vi.hoisted(() => vi.fn());
const showCloneRepoDialog = vi.hoisted(() => vi.fn());
const showConfirmDialog = vi.hoisted(() => vi.fn());
const deleteProjectApi = vi.hoisted(() => vi.fn());

const mockProjectsState = vi.hoisted(() => ({
  activeProjectId: 'proj-alpha' as string | undefined,
  projects: [
    {
      id: 'proj-alpha',
      name: 'frontend',
      root_path: 'C:\\Users\\dev\\acme\\frontend',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-beta',
      name: 'frontend',
      root_path: 'C:\\Users\\dev\\nebula\\frontend',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
    {
      id: 'proj-running',
      name: 'VibeX Core',
      root_path: 'C:\\Users\\dev\\vibex\\core',
      is_git: true,
      is_home: false,
      parent_project_id: null,
    },
  ],
}));

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({
    openSurfaceMenu,
  }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => {
    const active = mockProjectsState.projects.find(
      (item) => item.id === mockProjectsState.activeProjectId
    );
    return {
      projectId: mockProjectsState.activeProjectId,
      project: active ?? null,
    };
  },
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: mockProjectsState.projects,
    projectsById: Object.fromEntries(
      mockProjectsState.projects.map((item) => [item.id, item])
    ),
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useProjectSwitcher', () => ({
  useProjectSwitcher: () => switchProject,
}));

vi.mock('@/components/dialogs/projects/ProjectFormDialog', () => ({
  ProjectFormDialog: {
    show: showProjectFormDialog,
  },
}));

vi.mock('@/components/dialogs/projects/CloneRepoDialog', () => ({
  CloneRepoDialog: {
    show: showCloneRepoDialog,
  },
}));

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: showConfirmDialog,
  },
}));

vi.mock('@/lib/api', () => ({
  projectsApi: {
    delete: deleteProjectApi,
    create: vi.fn(),
    setParent: vi.fn(),
  },
}));

function renderSwitcher() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectQuickSwitcher />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ProjectQuickSwitcher', () => {
  beforeEach(() => {
    switchProject.mockReset();
    navigateMock.mockReset();
    openSurfaceMenu.mockReset();
    showProjectFormDialog.mockReset();
    showCloneRepoDialog.mockReset();
    showConfirmDialog.mockReset();
    deleteProjectApi.mockReset();
    mockProjectsState.activeProjectId = 'proj-alpha';
    useWindowProjectsStore.getState().resetProjectWindowState();
  });

  it('opens via Ctrl+Alt+P, pins running projects without duplication, filters by path, and switches with keyboard Enter', async () => {
    const user = userEvent.setup();
    useWindowProjectsStore.getState().setProjectSnapshot('proj-running', {
      isLoading: false,
      hasRunning: true,
      runningCount: 2,
      hasError: false,
      hasSessions: true,
      recentSessions: [],
    });

    renderSwitcher();

    const trigger = screen.getByTestId('toolbar-project-switcher');
    expect(trigger).toHaveTextContent('frontend');

    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, altKey: true });

    const searchInput = await screen.findByTestId(
      'project-switcher-search-input'
    );
    expect(searchInput).toBeInTheDocument();

    expect(
      screen.getAllByTestId('project-switcher-item-proj-running')
    ).toHaveLength(1);
    expect(screen.getByText('~/acme/frontend')).toBeInTheDocument();
    expect(screen.getByText('~/nebula/frontend')).toBeInTheDocument();

    await user.type(searchInput, 'nebula');
    expect(
      screen.queryByTestId('project-switcher-item-proj-alpha')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('project-switcher-item-proj-beta')
    ).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(switchProject).toHaveBeenCalledWith('proj-beta');
  });

  it('places the three creation actions above the standard Astryx search input with a single top divider, removes any divider above the list, and keeps deletion in context menu', async () => {
    const user = userEvent.setup();
    showConfirmDialog.mockResolvedValue('confirmed');
    deleteProjectApi.mockResolvedValue(undefined);

    renderSwitcher();
    await user.click(screen.getByTestId('toolbar-project-switcher'));

    const actionsBar = await screen.findByTestId('project-switcher-actions');
    const searchSection = screen.getByTestId('project-switcher-search-section');
    const searchInput = screen.getByTestId('project-switcher-search-input');
    const listbox = screen.getByRole('listbox');

    expect(
      screen.getByTestId('project-switcher-open-folder')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('project-switcher-create-project')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('project-switcher-clone-repo')
    ).toBeInTheDocument();

    // Actions bar sits above search section with a bottom border
    expect(
      actionsBar.compareDocumentPosition(searchSection) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(actionsBar.className).toContain('border-b');

    // Search section uses the standard Astryx TextInput frame and has no divider separating it from the project list
    expect(searchInput.closest('.astryx-text-input')).not.toBeNull();
    expect(
      searchSection.compareDocumentPosition(listbox) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(searchSection.className).not.toContain('border-b');
    expect(listbox.className).not.toContain('border-t');

    expect(screen.queryByText('新建应用窗口')).not.toBeInTheDocument();
    expect(
      document.querySelector('.project-rail-delete-button')
    ).not.toBeInTheDocument();

    const activeRow = screen.getByTestId('project-switcher-item-proj-alpha');
    fireEvent.contextMenu(activeRow);

    expect(openSurfaceMenu).toHaveBeenCalledTimes(1);
    const menuItems = openSurfaceMenu.mock.calls[0]?.[1] as Array<{
      id: string;
      onSelect: () => Promise<void> | void;
    }>;
    const removeItem = menuItems.find((item) => item.id === 'remove');
    expect(removeItem).toBeDefined();

    removeItem?.onSelect();
    await waitFor(() => {
      expect(deleteProjectApi).toHaveBeenCalledWith('proj-alpha');
      expect(navigateMock).toHaveBeenCalledWith(
        '/local-projects/proj-beta/sessions',
        { replace: true }
      );
    });
  });
});
