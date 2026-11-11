import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';
import { WorkspaceZeroProjectStage } from './WorkspaceZeroProjectStage';

const switchProject = vi.hoisted(() => vi.fn());
const showProjectFormDialog = vi.hoisted(() => vi.fn());
const showCloneRepoDialog = vi.hoisted(() => vi.fn());
const listDirectoryMock = vi.hoisted(() => vi.fn());
const dragDropListeners = vi.hoisted(
  () => [] as Array<(event: { payload: unknown }) => void>
);

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (listener: (event: { payload: unknown }) => void) => {
      dragDropListeners.push(listener);
      return () => undefined;
    },
  }),
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({
    openSurfaceMenu: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [{ id: 'home-proj', name: '__vibex_home__', is_home: true }],
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

vi.mock('@/lib/api', () => ({
  fileSystemApi: {
    list: listDirectoryMock,
  },
  projectsApi: {
    create: vi.fn(),
  },
}));

function renderZeroStage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspaceZeroProjectStage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('WorkspaceZeroProjectStage', () => {
  beforeEach(() => {
    switchProject.mockReset();
    showProjectFormDialog.mockReset();
    showCloneRepoDialog.mockReset();
    listDirectoryMock.mockReset();
    dragDropListeners.length = 0;
    useWindowProjectsStore.getState().resetProjectWindowState();
  });

  it('renders onboarding actions inside the unified workspace stage and opens a folder into sessions', async () => {
    const user = userEvent.setup();
    showProjectFormDialog.mockResolvedValue({
      status: 'saved',
      project: { id: 'proj-new', name: 'NewRepo' },
    });

    renderZeroStage();

    expect(
      screen.getByTestId('workspace-zero-project-stage')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('zero-project-create-project')
    ).toBeInTheDocument();
    expect(screen.getByTestId('zero-project-clone-repo')).toBeInTheDocument();
    expect(screen.getByTestId('zero-project-enter-global')).toBeInTheDocument();

    await user.click(screen.getByTestId('zero-project-open-folder'));
    expect(showProjectFormDialog).toHaveBeenCalledWith({
      autoOpenFolderPicker: true,
      initialFolderPath: undefined,
    });
    expect(switchProject).toHaveBeenCalledWith(
      'proj-new',
      '/local-projects/proj-new/sessions'
    );
  });

  it('accepts dropped project folders directly onto the stage', async () => {
    listDirectoryMock.mockResolvedValue({ entries: [] });
    showProjectFormDialog.mockResolvedValue({
      status: 'saved',
      project: { id: 'proj-dropped', name: 'DroppedRepo' },
    });

    renderZeroStage();

    await waitFor(() => {
      expect(dragDropListeners.length).toBeGreaterThan(0);
    });

    dragDropListeners[0]?.({
      payload: {
        type: 'drop',
        paths: ['C:\\Users\\dev\\DroppedRepo'],
      },
    });

    await waitFor(() => {
      expect(showProjectFormDialog).toHaveBeenCalledWith({
        autoOpenFolderPicker: false,
        initialFolderPath: 'C:\\Users\\dev\\DroppedRepo',
      });
    });
    expect(switchProject).toHaveBeenCalledWith(
      'proj-dropped',
      '/local-projects/proj-dropped/sessions'
    );
  });
});
