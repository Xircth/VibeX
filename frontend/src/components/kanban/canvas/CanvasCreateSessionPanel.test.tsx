import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CanvasCreateSessionPanel } from './CanvasCreateSessionPanel';

vi.mock('@/components/sessions/SessionCreationForm', () => ({
  SessionCreationForm: ({
    onSubmit,
    onCancel,
  }: {
    onSubmit: () => void;
    onCancel?: () => void;
  }) => (
    <div>
      <button type="button" onClick={onSubmit}>
        创建会话
      </button>
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  ),
}));

describe('CanvasCreateSessionPanel', () => {
  it('places the create form beside the session list', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const client = new QueryClient();

    render(
      <QueryClientProvider client={client}>
        <CanvasCreateSessionPanel
          createMode="existing_workspace"
          onCreateModeChange={vi.fn()}
          workspaceBranchOptions={[]}
          createWorkspaceValue=""
          onCreateWorkspaceValueChange={vi.fn()}
          createSessionName=""
          onCreateSessionNameChange={vi.fn()}
          profiles={null}
          selectedExecutorProfile={null}
          onSelectedExecutorProfileChange={vi.fn()}
          repoBranchConfigs={[]}
          onRepoBranchChange={vi.fn()}
          isLoadingRepoBranches={false}
          canCreateSession
          isCreatePending={false}
          createError={null}
          onSubmit={onSubmit}
          onClose={onClose}
        />
      </QueryClientProvider>
    );

    expect(screen.getByText('新增会话')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建会话' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
