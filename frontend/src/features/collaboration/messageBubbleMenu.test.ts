import { describe, expect, it, vi } from 'vitest';

import {
  MESSAGE_REACTION_EMOJIS,
  MESSAGE_REACTION_EXTRA_EMOJIS,
  buildMessageBubbleMenuItems,
} from './messageBubbleMenu';

const labels = (
  items: ReturnType<typeof buildMessageBubbleMenuItems>
) =>
  items.map((item) => {
    if (item.type === 'separator') return '---';
    if (item.type === 'emoji-row') return item.emojis.join('');
    return item.label;
  });

describe('message bubble menu', () => {
  it('lists reaction emojis, reply, copy and copy request id', () => {
    const onReact = vi.fn();
    const items = buildMessageBubbleMenuItems({
      canCopyRequestId: true,
      onReact,
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onCopyRequestId: vi.fn(),
    });
    expect(labels(items)).toEqual([
      '👍👎❤️😄🎉',
      '---',
      '回复',
      '复制',
      '复制请求 ID',
    ]);
    const row = items[0];
    expect(row.type).toBe('emoji-row');
    if (row.type === 'emoji-row') {
      expect(row.emojis).toEqual([...MESSAGE_REACTION_EMOJIS]);
      expect(row.extraEmojis).toEqual([...MESSAGE_REACTION_EXTRA_EMOJIS]);
      row.onPick('👍');
    }
    expect(onReact).toHaveBeenCalledWith('👍');
  });

  it('disables copy request id when the message has no stable id', () => {
    const items = buildMessageBubbleMenuItems({
      canCopyRequestId: false,
      onReact: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onCopyRequestId: vi.fn(),
    });
    const copyId = items.find((item) => item.id === 'copy-request-id');
    expect(copyId && 'disabled' in copyId && copyId.disabled).toBe(true);
  });

  it('includes save-to-collection and distill-memory actions when handlers are provided', () => {
    const onSaveToCollection = vi.fn();
    const onDistillMemory = vi.fn();
    const items = buildMessageBubbleMenuItems({
      canCopyRequestId: true,
      onReact: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onCopyRequestId: vi.fn(),
      onSaveToCollection,
      onDistillMemory,
    });
    expect(labels(items)).toEqual([
      '👍👎❤️😄🎉',
      '---',
      '回复',
      '复制',
      '复制请求 ID',
      '---',
      '收藏到本空间',
      '提炼为记忆',
    ]);
  });
});
