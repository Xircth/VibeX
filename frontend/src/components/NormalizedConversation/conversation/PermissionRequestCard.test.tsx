import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  it('renders the real file path from the ACP diff detail', () => {
    render(
      <PermissionRequestCard
        request={fileEditRequest()}
        onRespond={vi.fn()}
      />
    );

    expect(screen.getByText('Edit README.md')).toBeInTheDocument();
    // The diff block surfaces the real path the agent wants to touch.
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('answers with the selected option id', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard request={fileEditRequest()} onRespond={onRespond} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(onRespond).toHaveBeenCalledWith('perm-1', {
      kind: 'selected',
      option_id: 'allow',
    });
  });

  it('cancels the request via the cancel action', () => {
    const onRespond = vi.fn();
    render(
      <PermissionRequestCard request={fileEditRequest()} onRespond={onRespond} />
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

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
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
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

    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });
});
