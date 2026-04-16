import { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

function Harness() {
  const [isCreatePopoverOpen, setIsCreatePopoverOpen] = useState(false);

  return (
    <SessionHubSidebar
      width={320}
      isLoading={false}
      sessions={[]}
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
      createWorkspaceOptions={[
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
      profiles={null}
      createMode="existing_workspace"
      createWorkspaceId="workspace-1"
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
      onResizeMouseDown={vi.fn()}
      onCreatePopoverOpenChange={setIsCreatePopoverOpen}
      onCreateSession={vi.fn()}
      onCreateModeChange={vi.fn()}
      onCreateWorkspaceIdChange={vi.fn()}
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
      onExpandedChange={vi.fn()}
    />
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
});
