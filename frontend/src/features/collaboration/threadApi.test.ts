import { describe, expect, it, vi } from 'vitest';
import {
  loadDirectMessages,
  loadSidebarItems,
  postDirectMessage,
  reactToSpaceMessage,
  markThreadRead,
  markThreadUnread,
  resolveMemberSession,
  updateThreadTagColor,
  type CollaborationCaller,
} from './threadApi';

const caller = (impl: (method: string, params: unknown) => unknown) =>
  vi.fn(async (_service: string, method: string, params: unknown) =>
    impl(method, params)
  ) as unknown as CollaborationCaller & ReturnType<typeof vi.fn>;

describe('threadApi', () => {
  it('loads sidebar items', async () => {
    const call = caller(() => ({
      items: [{ kind: 'dm', thread_id: 'direct:a' }],
    }));
    await expect(loadSidebarItems(call, 'w')).resolves.toEqual([
      { kind: 'dm', thread_id: 'direct:a' },
    ]);
    expect(call).toHaveBeenCalledWith('collaboration', 'thread.listSidebar', {
      workspaceId: 'w',
    });
  });

  it('returns null when the backend does not know thread.listSidebar', async () => {
    const call = caller(() => {
      throw new Error('unknown command: thread.listSidebar');
    });
    await expect(loadSidebarItems(call, 'w')).resolves.toBeNull();
    await expect(
      loadSidebarItems(
        caller(() => ({})),
        'w'
      )
    ).resolves.toBeNull();
  });

  it('marks direct threads by threadId and groups by spaceId', async () => {
    const call = caller(() => ({}));
    await markThreadRead(call, 'direct:m1');
    await markThreadRead(call, 'sp-1', 4);
    expect(call).toHaveBeenNthCalledWith(
      1,
      'collaboration',
      'thread.markRead',
      {
        threadId: 'direct:m1',
      }
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      'collaboration',
      'thread.markRead',
      {
        spaceId: 'sp-1',
        seq: 4,
      }
    );
  });

  it('updates tag colour and reports failure for the local fallback', async () => {
    const ok = caller(() => ({}));
    await expect(updateThreadTagColor(ok, 'sp-1', '')).resolves.toBe(true);
    expect(ok).toHaveBeenCalledWith('collaboration', 'thread.update', {
      spaceId: 'sp-1',
      tagColor: '',
    });
    const missing = caller(() => {
      throw new Error('unknown command');
    });
    await expect(updateThreadTagColor(missing, 'sp-1', 'blue')).resolves.toBe(
      false
    );
  });

  it('resolves a member session per thread', async () => {
    const call = caller(() => ({ conversationId: 'conv-t' }));
    await expect(resolveMemberSession(call, 'm1', 'sp-1')).resolves.toBe(
      'conv-t'
    );
    expect(call).toHaveBeenCalledWith(
      'collaboration',
      'member.session.resolve',
      { memberId: 'm1', threadId: 'sp-1' }
    );
    await expect(
      resolveMemberSession(
        caller(() => ({})),
        'm1',
        'sp-1'
      )
    ).resolves.toBeNull();
  });

  it('loads DM messages via space.listMessages with the direct thread id', async () => {
    const call = caller(() => ({
      messages: [{ seq: 3, conversationId: 'c1', envelope: {} }],
    }));
    await expect(loadDirectMessages(call, 'direct:m1')).resolves.toEqual({
      messages: [{ seq: 3, conversationId: 'c1', envelope: {} }],
    });
    expect(call).toHaveBeenCalledWith('collaboration', 'space.listMessages', {
      spaceId: 'direct:m1',
      latest: true,
      limit: 200,
    });
    await loadDirectMessages(call, 'direct:m1', 3);
    expect(call).toHaveBeenLastCalledWith(
      'collaboration',
      'space.listMessages',
      { spaceId: 'direct:m1', latest: true, limit: 200 }
    );
  });

  it('returns null when DM listMessages fails', async () => {
    const call = caller(() => {
      throw new Error('boom');
    });
    await expect(loadDirectMessages(call, 'direct:m1')).resolves.toBeNull();
  });

  it('posts DM messages without recipients or delay', async () => {
    const call = caller(() => ({ seq: 9 }));
    await expect(
      postDirectMessage(call, 'direct:m1', 'hi', 'op-1')
    ).resolves.toEqual({ seq: 9 });
    expect(call).toHaveBeenCalledWith('collaboration', 'space.post', {
      spaceId: 'direct:m1',
      content: 'hi',
      operationId: 'op-1',
    });
  });

  it('posts DM messages with an inReplyTo target', async () => {
    const call = caller(() => ({ seq: 11 }));
    await postDirectMessage(
      call,
      'direct:m1',
      '收到',
      'op-3',
      undefined,
      'msg-parent'
    );
    expect(call).toHaveBeenCalledWith('collaboration', 'space.post', {
      spaceId: 'direct:m1',
      content: '收到',
      operationId: 'op-3',
      inReplyTo: 'msg-parent',
    });
  });

  it('toggles a reaction on a space message', async () => {
    const call = caller(() => ({
      reactions: [{ emoji: '👍', actor: 'user' }],
    }));
    await expect(
      reactToSpaceMessage(call, 's1', 'msg-1', '👍')
    ).resolves.toEqual([{ emoji: '👍', actor: 'user' }]);
    expect(call).toHaveBeenCalledWith('collaboration', 'space.react', {
      spaceId: 's1',
      messageId: 'msg-1',
      emoji: '👍',
    });
  });

  it('posts DM messages with mention recipients so other bots can be addressed', async () => {
    const call = caller(() => ({ seq: 10 }));
    await expect(
      postDirectMessage(call, 'direct:m1', '@小B 请协助', 'op-2', ['小B'])
    ).resolves.toEqual({ seq: 10 });
    expect(call).toHaveBeenCalledWith('collaboration', 'space.post', {
      spaceId: 'direct:m1',
      content: '@小B 请协助',
      operationId: 'op-2',
      to: ['小B'],
    });
  });

  it('marks a DM read by threadId with seq', async () => {
    const call = caller(() => ({}));
    await markThreadRead(call, 'direct:m1', 7);
    expect(call).toHaveBeenCalledWith('collaboration', 'thread.markRead', {
      threadId: 'direct:m1',
      seq: 7,
    });
  });

  it('marks threads unread with the same thread/space targeting as markRead', async () => {
    const call = caller(() => ({}));
    await markThreadUnread(call, 'direct:m1');
    await markThreadUnread(call, 'sp-1');
    expect(call).toHaveBeenNthCalledWith(
      1,
      'collaboration',
      'thread.markUnread',
      { threadId: 'direct:m1' }
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      'collaboration',
      'thread.markUnread',
      { spaceId: 'sp-1' }
    );
  });
});
