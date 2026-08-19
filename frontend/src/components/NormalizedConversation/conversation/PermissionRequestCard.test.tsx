import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationPermissionView } from 'shared/types';
import { PermissionRequestCard } from './PermissionRequestCard';

function fileEditRequest(
  overrides: Partial<ConversationPermissionView> = {}
): ConversationPermissionView {
  return {
    permission_id: 'perm-1',
    title: 'Edit README.md',
    status: 'pending',
    details: {
      fields: {
        kind: 'edit',
        content: [
          {
            type: 'diff',
            path: 'README.md',
            oldText: 'old line',
            newText: 'new line',
          },
        ],
      },
    },
    options: [
      { id: 'allow', label: 'Allow', kind: 'allow_once' },
      { id: 'deny', label: 'Deny', kind: 'reject_once' },
    ],
    ...overrides,
  };
}

describe('PermissionRequestCard', () => {
  it('presents a terminal permission with the request title and exact command', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Run the project test command',
          details: {
            fields: {
              kind: 'execute',
              rawInput: { command: 'pnpm test --runInBand' },
            },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('终端')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '权限申请' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Run the project test command')
    ).toBeInTheDocument();
    expect(screen.getByText('pnpm test --runInBand')).toBeInTheDocument();
    expect(
      document.querySelector('.permission-request-preview')
    ).not.toBeNull();
  });

  it('renders the real file path from the ACP diff detail', () => {
    render(
      <PermissionRequestCard request={fileEditRequest()} onRespond={vi.fn()} />
    );

    expect(screen.getByText('Edit README.md')).toBeInTheDocument();
    // The diff block surfaces the real path the agent wants to touch.
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('answers with the selected option id', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '允许' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow',
    });
  });

  it('keeps broader approval scopes behind the allow split menu', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          options: [
            {
              id: 'allow-once',
              label: '允许一次',
              kind: 'allow_once',
            },
            {
              id: 'allow-similar',
              label: '允许类似命令',
              kind: 'allow_always',
              description: '本会话中匹配该命令前缀的请求',
            },
            { id: 'reject', label: '拒绝', kind: 'reject_once' },
          ],
        })}
        onRespond={onRespond}
      />
    );

    expect(
      screen.queryByRole('menuitem', { name: '本次会话中允许' })
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开允许选项' }));
    expect(
      screen.getByRole('menuitem', { name: '允许一次' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '总是允许全部' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '本次会话中允许' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow-similar',
    });
  });

  it('uses the agent-provided reject option for the reject action', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'deny',
    });
  });

  it('cancels safely when the agent provides no reject option', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
        })}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', { kind: 'cancelled' });
  });

  it('shows a resolved state instead of action buttons once answered', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest({ status: 'responded' })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('已响应')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
  });

  it('renders a command preview from rawInput when there is no content block', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest({
          title: 'Run command',
          details: {
            fields: { kind: 'execute', rawInput: { command: 'rm -rf build' } },
          },
        })}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('rm -rf build')).toBeInTheDocument();
  });

  it('disables actions while a response is in flight', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={vi.fn()}
        responding
      />
    );

    expect(screen.getByRole('button', { name: '允许' })).toBeDisabled();
  });
});
