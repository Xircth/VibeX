import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageQueueIndicator } from './MessageQueueIndicator';
import type { QueuedMessage } from './sessionComposerQueue';

const queuedMessage: QueuedMessage = {
  session_id: 'session-1',
  created_at: '2026-05-25T00:00:00.000Z',
  updated_at: '2026-05-25T00:00:00.000Z',
  data: {
    message: 'Run the next fix',
    images: ['.vibe-images/queued.png'],
  },
};

describe('MessageQueueIndicator', () => {
  it('expands queued message details and exposes queue actions', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <MessageQueueIndicator
        isQueued
        queuedMessage={queuedMessage}
        messagePreview="Run the next fix"
        attachmentCount={1}
        onEditQueuedMessage={onEdit}
        onDeleteQueuedMessage={onDelete}
      />
    );

    expect(screen.getByText('Run the next fix')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: /消息已排队/,
      })
    );
    expect(screen.getByText('.vibe-images/queued.png')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑队列消息' }));
    expect(onEdit).toHaveBeenCalledWith(queuedMessage);

    fireEvent.click(screen.getByRole('button', { name: '删除队列消息' }));
    expect(onDelete).toHaveBeenCalledTimes(1);

    expect(screen.getByRole('button', { name: '上移队列消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下移队列消息' })).toBeDisabled();
  });

  it('does not render when the queue is empty', () => {
    const { container } = render(<MessageQueueIndicator isQueued={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

