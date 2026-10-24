import type { SidebarItem } from './spaceModel';

/** Minimal shape of the collaboration RPC used by the page. */
export type CollaborationCaller = <T>(
  service: 'collaboration',
  method: string,
  params: Record<string, unknown>
) => Promise<T>;

/**
 * `thread.listSidebar`; resolves `null` when the backend does not know the
 * command (or errors) so callers fall back to deriving the list locally.
 */
export async function loadSidebarItems(
  call: CollaborationCaller,
  workspaceId: string
): Promise<SidebarItem[] | null> {
  try {
    const page = await call<{ items?: SidebarItem[] }>(
      'collaboration',
      'thread.listSidebar',
      { workspaceId }
    );
    return Array.isArray(page?.items) ? page.items : null;
  } catch {
    return null;
  }
}

function threadTarget(id: string): { threadId: string } | { spaceId: string } {
  return id.startsWith('direct:') ? { threadId: id } : { spaceId: id };
}

/** `thread.markRead`; best effort, never throws. */
export async function markThreadRead(
  call: CollaborationCaller,
  id: string,
  seq?: number
): Promise<boolean> {
  try {
    await call('collaboration', 'thread.markRead', {
      ...threadTarget(id),
      ...(typeof seq === 'number' ? { seq } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** `thread.update` tag colour ('' clears). False means use the local fallback. */
export async function updateThreadTagColor(
  call: CollaborationCaller,
  id: string,
  tagColor: string
): Promise<boolean> {
  try {
    await call('collaboration', 'thread.update', {
      ...threadTarget(id),
      tagColor,
    });
    return true;
  } catch {
    return false;
  }
}

/** `member.session.resolve`; null when unavailable. */
export async function resolveMemberSession(
  call: CollaborationCaller,
  memberId: string,
  threadId: string
): Promise<string | null> {
  try {
    const result = await call<{ conversationId?: string }>(
      'collaboration',
      'member.session.resolve',
      { memberId, threadId }
    );
    return result?.conversationId || null;
  } catch {
    return null;
  }
}
