import { useState, type ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionHubSidebar } from './SessionHubSidebar';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PointerSensor: function PointerSensor() {
    return null;
  },
  closestCenter: vi.fn(),
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  }),
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Translate: {
      toString: () => '',
    },
  },
}));

vi.mock('@/components/tasks/TerminalProfileControls', () => ({
  TerminalProfileControls: () => <div data-testid="profile-controls" />,
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: { lastSessionControls: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: { previous_session_continuation_enabled: false },
  }),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

type SidebarProps = ComponentProps<typeof SessionHubSidebar>;

function Harness({
  archivedSessions = [],
  isArchiveView = false,
  onArchiveViewChange = vi.fn(),
  onRestoreArchivedSession = vi.fn(),
}: {
  archivedSessions?: SidebarProps['archivedSessions'];
  isArchiveView?: boolean;
  onArchiveViewChange?: SidebarProps['onArchiveViewChange'];
  onRestoreArchivedSession?: SidebarProps['onRestoreArchivedSession'];
}) {
  const [isCreatePopoverOpen, setIsCreatePopoverOpen] = useState(false);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionHubSidebar
        width={320}
        isLoading={false}
        sessions={[]}
        archivedSessions={archivedSessions}
        groupedSessions={{}}
        flatSessions={[]}
        workspaces={[
          {
            id: 'workspace-1',
            project_id: 'project-1',
            task_id: 'task-1',
            parent_workspace_id: null,
            container_ref: null,
            branch: 'main',
            use_worktree: true,
            agent_working_dir: null,
            setup_completed_at: null,
            created_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:00:00.000Z',
            archived: false,
            pinned: false,
            name: 'Main',
          },
        ]}
        workspaceBranchOptions={[
          {
            value: 'workspace:workspace-1',
            branch: 'main',
            workspace: {
              id: 'workspace-1',
              project_id: 'project-1',
              task_id: 'task-1',
              parent_workspace_id: null,
              container_ref: null,
              branch: 'main',
              use_worktree: true,
              agent_working_dir: null,
              setup_completed_at: null,
              created_at: '2026-04-15T00:00:00.000Z',
              updated_at: '2026-04-15T00:00:00.000Z',
              archived: false,
              pinned: false,
              name: 'Main',
            },
            existingWorkspaceId: 'workspace-1',
            directWorkspaceId: 'workspace-1',
            useWorktree: true,
            isCurrentProjectBranch: true,
          },
        ]}
        profiles={null}
        createMode="existing_workspace"
        createWorkspaceValue="workspace:workspace-1"
        createSessionName=""
        selectedExecutorProfile={null}
        repoBranchConfigs={[]}
        isLoadingRepoBranches={false}
        isCreatePopoverOpen={isCreatePopoverOpen}
        sortField={null}
        workspaceFilterIds={[]}
        executorFilterValues={[]}
        executorFilterOptions={[]}
        expandedSections={{}}
        isDeleteMode={false}
        selectedSessionIdSet={new Set()}
        deleteErrorMessage={null}
        deleteSuccessMessage={null}
        isDeletingSessions={false}
        canCreateSession={true}
        isCreatePending={false}
        createError={null}
        displayedCount={0}
        monitorPlacements={[]}
        currentExecutionPlacement={null}
        isArchiveView={isArchiveView}
        onResizeMouseDown={vi.fn()}
        onArchiveViewChange={onArchiveViewChange}
        onCreatePopoverOpenChange={setIsCreatePopoverOpen}
        onCreateSession={vi.fn()}
        onCreateModeChange={vi.fn()}
        onCreateWorkspaceValueChange={vi.fn()}
        onCreateSessionNameChange={vi.fn()}
        onSelectedExecutorProfileChange={vi.fn()}
        onRepoBranchChange={vi.fn()}
        onSortFieldChange={vi.fn()}
        onWorkspaceFilterIdsChange={vi.fn()}
        onExecutorFilterValuesChange={vi.fn()}
        onResetViewState={vi.fn()}
        onToggleDeleteMode={vi.fn()}
        onCancelDeleteMode={vi.fn()}
        onDeleteSelectedSessions={vi.fn(async () => undefined)}
        onSessionClick={vi.fn()}
        onToggleSessionSelection={vi.fn()}
        onRenameSession={vi.fn(async () => undefined)}
        onSessionStatusChange={vi.fn()}
        onRestoreArchivedSession={onRestoreArchivedSession}
        onExpandedChange={vi.fn()}
      />
    </QueryClientProvider>
  );
}

describe('SessionHubSidebar', () => {
  it('keeps the create-session popover open when the workspace select is clicked twice', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    const openButton = container
      .querySelector('svg.lucide-plus')
      ?.closest('button');
    expect(openButton).not.toBeNull();

    await user.click(openButton as HTMLButtonElement);

    await waitFor(() => {
      expect(
        document.querySelector('#session-create-workspace')
      ).not.toBeNull();
      expect(document.querySelector('#session-create-name')).not.toBeNull();
    });

    const workspaceTrigger = document.querySelector(
      '#session-create-workspace'
    ) as HTMLButtonElement | null;
    expect(workspaceTrigger).not.toBeNull();

    fireEvent.mouseDown(workspaceTrigger as HTMLButtonElement);
    fireEvent.mouseDown(workspaceTrigger as HTMLButtonElement);

    expect(document.querySelector('#session-create-workspace')).not.toBeNull();
    expect(document.querySelector('#session-create-name')).not.toBeNull();
  });

  it('keeps delete available in archive view and styles the archive toggle distinctly', () => {
    const { container } = render(<Harness isArchiveView={true} />);

    const archiveButton = container
      .querySelector('svg.lucide-archive')
      ?.closest('button');
    const deleteButton = container
      .querySelector('svg.lucide-trash-2')
      ?.closest('button');

    expect(deleteButton).not.toBeNull();
    expect(deleteButton).toHaveClass('order-1');
    expect(archiveButton).not.toBeNull();
    expect(archiveButton).toHaveClass('order-2', 'border', 'border-border/60');
  });

  it('restores archived sessions from the archive context menu', async () => {
    const user = userEvent.setup();
    const onRestoreArchivedSession = vi.fn();
    const archivedSession: SidebarProps['archivedSessions'][number] = {
      id: 'session-1',
      placement: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
      },
      workspace: {
        id: 'workspace-1',
        project_id: 'project-1',
        task_id: 'task-1',
        parent_workspace_id: null,
        container_ref: null,
        branch: 'main',
        use_worktree: true,
        agent_working_dir: null,
        setup_completed_at: null,
        created_at: '2026-04-15T00:00:00.000Z',
        updated_at: '2026-04-15T00:00:00.000Z',
        archived: false,
        pinned: false,
        name: 'Main',
      },
      task: null,
      taskId: null,
      name: 'Archived Session',
      status: 'archived',
      branch: 'main',
      workspaceName: 'Main',
      workspaceDisplayLabel: 'Main · main',
      executor: null,
      updatedAt: '2026-04-15T00:00:00.000Z',
      createdAt: '2026-04-15T00:00:00.000Z',
      firstPrompt: null,
      fullName: 'Archived Session',
      shortName: 'Archive',
      taskTitle: null,
      isCompleted: false,
      isRunning: false,
      isErrored: false,
      pinnedAt: null,
    };

    render(
      <Harness
        archivedSessions={[archivedSession]}
        isArchiveView={true}
        onRestoreArchivedSession={onRestoreArchivedSession}
      />
    );

    fireEvent.contextMenu(screen.getByText('Archived Session'));
    await user.click(screen.getByText('移至会话列表'));

    expect(onRestoreArchivedSession).toHaveBeenCalledWith(archivedSession);
  });
});
