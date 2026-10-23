import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MessageQueueIndicator } from './MessageQueueIndicator';
import type { QueuedMessage } from './sessionComposerQueue';

const normalMsg: QueuedMessage = {
  id: 'msg-normal-1',
  session_id: 'session-1',
  operationId: 'op-1',
  revision: 1n,
  sortKey: 1n,
  status: 'queued',
  deliverAt: null,
  data: {
    message: '普通排队消息内容',
    agentMessage: '普通排队消息内容',
    images: [],
    pluginActions: [],
  },
  executorProfileId: { executor: 'CLAUDE_CODE' },
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
};

const delayedMsg: QueuedMessage = {
  ...normalMsg,
  id: 'msg-delayed-1',
  operationId: 'op-2',
  status: 'scheduled',
  deliverAt: new Date(Date.now() + 185_000).toISOString(),
  data: {
    message: '延时发送的消息内容',
    agentMessage: '延时发送的消息内容',
    images: [],
    pluginActions: [],
  },
};

describe('MessageQueueIndicator', () => {
  it('renders delayed messages as an independent queue with countdown timer and converts normal queued messages via the clock minutes input', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onDelay = vi.fn();

    render(
      <MessageQueueIndicator
        queuedMessages={[normalMsg]}
        delayedMessages={[delayedMsg]}
        onEditQueuedMessage={onEdit}
        onDeleteQueuedMessage={onDelete}
        onDelayQueuedMessage={onDelay}
      />
    );

    const normalQueue = screen.getByTestId('normal-message-queue');
    const delayedQueue = screen.getByTestId('delayed-message-queue');
    expect(delayedQueue).toHaveTextContent('延时发送的消息内容');

    const countdownEl = screen.getByTestId(
      'delayed-countdown-msg-delayed-1'
    );
    expect(countdownEl.textContent).toMatch(/\d{2}:\d{2}$/);

    // Expand normal queue to interact with items
    fireEvent.click(normalQueue.querySelector('button')!);
    expect(normalQueue).toHaveTextContent('普通排队消息内容');

    // Clock button is rendered on normal queue item to the right of Edit button
    const clockBtn = screen.getByTestId('delay-queued-message-msg-normal-1');
    expect(clockBtn).toBeTruthy();

    fireEvent.click(clockBtn);
    const minutesInput = screen.getByTestId('delay-minutes-input-msg-normal-1');
    expect(minutesInput).toBeTruthy();

    fireEvent.change(minutesInput, { target: { value: '5' } });
    fireEvent.keyDown(minutesInput, { key: 'Enter' });

    expect(onDelay).toHaveBeenCalledWith(normalMsg, 300);
  });
});
