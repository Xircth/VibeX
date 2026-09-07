import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WelcomePage } from './WelcomePage';

const showProjectForm = vi.hoisted(() => vi.fn());
const listDirectory = vi.hoisted(() => vi.fn());
const openLocalAppWindow = vi.hoisted(() => vi.fn());
const useTauriClient = vi.hoisted(() => vi.fn(() => true));
const webviewMock = vi.hoisted(() => ({
  handler: null as ((event: unknown) => void) | null,
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@/components/dialogs/projects/ProjectFormDialog', () => ({
  ProjectFormDialog: { show: showProjectForm },
}));
vi.mock('@/components/dialogs/projects/CloneRepoDialog', () => ({
  CloneRepoDialog: { show: vi.fn() },
}));
vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));
vi.mock('@/hooks', () => ({
  useProjectRepos: () => ({ data: [] }),
}));
vi.mock('@/lib/api', () => ({
  fileSystemApi: { list: listDirectory },
  projectsApi: { create: vi.fn(), delete: vi.fn() },
  settingsWindowApi: { open: vi.fn() },
  useOpenSettings: () => vi.fn(),
}));
vi.mock('@/lib/api/appWindow', () => ({
  openLocalAppWindow,
}));
vi.mock('@/lib/desktopShell', () => ({
  useTauriClient,
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: webviewMock.onDragDropEvent,
  }),
}));

function renderWelcome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WelcomePage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('WelcomePage start menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTauriClient.mockReturnValue(true);
    webviewMock.onDragDropEvent.mockResolvedValue(webviewMock.unlisten);
  });

  it('opens a local app window from the start menu', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWelcome();
    await user.click(
      screen.getByRole('button', { name: /新建窗口|New Window/i })
    );
    expect(openLocalAppWindow).toHaveBeenCalledOnce();
  });

  it('hides new window on Web', () => {
    useTauriClient.mockReturnValue(false);
    renderWelcome();
    expect(
      screen.queryByRole('button', { name: /新建窗口|New Window/i })
    ).not.toBeInTheDocument();
  });
});

describe('WelcomePage folder drop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTauriClient.mockReturnValue(true);
    webviewMock.handler = null;
    webviewMock.onDragDropEvent.mockImplementation(async (handler) => {
      webviewMock.handler = handler;
      return webviewMock.unlisten;
    });
    listDirectory.mockResolvedValue({ entries: [], current_path: '/repo' });
    showProjectForm.mockResolvedValue({ status: 'canceled' });
  });

  it('opens the select-folder dialog with a dropped directory', async () => {
    renderWelcome();
    await waitFor(() => expect(webviewMock.handler).not.toBeNull());

    act(() => {
      webviewMock.handler?.({
        payload: {
          type: 'enter',
          paths: ['/Users/mac/Projects/app'],
          position: { x: 10, y: 10 },
        },
      });
    });
    expect(
      screen.getByRole('status', { name: /松开以打开此文件夹|drop to open/i })
    ).toBeVisible();

    act(() => {
      webviewMock.handler?.({
        payload: {
          type: 'drop',
          paths: ['/Users/mac/Projects/app'],
          position: { x: 10, y: 10 },
        },
      });
    });

    await waitFor(() =>
      expect(showProjectForm).toHaveBeenCalledWith({
        autoOpenFolderPicker: false,
        initialFolderPath: '/Users/mac/Projects/app',
      })
    );
  });

  it('rejects dropped files that are not folders', async () => {
    listDirectory.mockRejectedValue(new Error('Path is not a directory'));
    renderWelcome();
    await waitFor(() => expect(webviewMock.handler).not.toBeNull());

    act(() => {
      webviewMock.handler?.({
        payload: {
          type: 'drop',
          paths: ['/Users/mac/Projects/app/README.md'],
          position: { x: 10, y: 10 },
        },
      });
    });

    await waitFor(() => expect(listDirectory).toHaveBeenCalled());
    expect(showProjectForm).not.toHaveBeenCalled();
  });
});
