import { describe, expect, it, vi } from 'vitest';
import {
  loadSidebarItems,
  markThreadRead,
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
});
