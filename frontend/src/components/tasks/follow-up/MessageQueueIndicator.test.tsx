import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageQueueIndicator } from './MessageQueueIndicator';
import type { QueuedMessage } from './sessionComposerQueue';

function message(
  id: string,
  text: string,
  status: QueuedMessage['status'] = 'queued'
): QueuedMessage {
  return {
    id,
    session_id: 'session-1',
    revision: 1n,
    sortKey: id === 'input-1' ? 1024n : 2048n,
    status,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
    executorProfileId: { executor: 'codex' },
    data: {
      message: text,
      images: [],
      pluginActions: [],
    },
  };
}

describe('MessageQueueIndicator', () => {
  it('renders a compact multi-message queue with scoped actions', () => {
    const messages = [
      message('input-1', 'First'),
      message('input-2', 'Second'),
    ];
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onMove = vi.fn();

    render(
      <MessageQueueIndicator
        isQueued
        queuedMessages={messages}
        onEditQueuedMessage={onEdit}
        onDeleteQueuedMessage={onDelete}
        onMoveQueuedMessage={onMove}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /已排队 2 条消息/ }));
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();

    const editButtons = screen.getAllByRole('button', { name: '编辑队列消息' });
    fireEvent.click(editButtons[1]);
    expect(onEdit).toHaveBeenCalledWith(messages[1]);

    const deleteButtons = screen.getAllByRole('button', {
      name: '删除队列消息',
    });
    fireEvent.click(deleteButtons[0]);
    expect(onDelete).toHaveBeenCalledWith(messages[0]);

    const moveDown = screen.getAllByRole('button', { name: '下移队列消息' });
    fireEvent.click(moveDown[0]);
    expect(onMove).toHaveBeenCalledWith(messages[0], 1);
    expect(moveDown[1]).toBeDisabled();
  });

  it('locks a claimed message while dispatch is in progress', () => {
    render(
      <MessageQueueIndicator
        isQueued
        queuedMessages={[message('input-1', 'Sending', 'claimed')]}
        onEditQueuedMessage={vi.fn()}
        onDeleteQueuedMessage={vi.fn()}
        onMoveQueuedMessage={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /已排队 1 条消息/ }));
    expect(screen.getByLabelText('正在发送')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑队列消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除队列消息' })).toBeDisabled();
  });

  it('does not render when the queue is empty', () => {
    const { container } = render(
      <MessageQueueIndicator isQueued={false} queuedMessages={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
