import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationPermissionView } from 'shared/types';

const useConversationTimeline = vi.hoisted(() => vi.fn());
const respondPermission = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/features/conversation/useConversationTimeline', () => ({
  useConversationTimeline,
}));

import { CollaborationThreadPermissionDock } from './CollaborationThreadPermissionDock';

function pendingRequest(): ConversationPermissionView {
  return {
    permission_id: 'perm-collab-1',
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
  };
}

describe('CollaborationThreadPermissionDock', () => {
  beforeEach(() => {
    respondPermission.mockReset();
    respondPermission.mockResolvedValue(undefined);
    useConversationTimeline.mockReset();
  });

  it('renders nothing when the bound conversation has no pending permission', () => {
    useConversationTimeline.mockReturnValue({
      sideRows: [],
      respondPermission,
    });
    const { container } = render(
      <CollaborationThreadPermissionDock conversationId="conv-1" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the same permission card and answers through conversation.respondPermission', async () => {
    const user = userEvent.setup();
    useConversationTimeline.mockReturnValue({
      sideRows: [
        {
          row: {
            kind: 'permission_request',
            request: pendingRequest(),
          },
        },
      ],
      respondPermission,
    });
    render(<CollaborationThreadPermissionDock conversationId="conv-1" />);

    expect(
      screen.getByTestId('collaboration-thread-permission-dock-conv-1')
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: '权限申请' })).toBeTruthy();
    expect(screen.getByText('Edit README.md')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '允许' }));
    expect(respondPermission).toHaveBeenCalledWith(
      'perm-collab-1',
      expect.objectContaining({ kind: 'selected', option_id: 'allow' })
    );
  });
});
