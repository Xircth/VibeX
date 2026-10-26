import {
  normalizeMemberNickname,
  resolveMemberIdentityId,
  type SidebarItem,
  type SpaceMember,
} from './spaceModel';

/** Minimal shape of the collaboration RPC used by the page. */
export type CollaborationCaller = <T>(
  service: 'collaboration',
  method: string,
  params: Record<string, unknown>
) => Promise<T>;

/**
 * `thread.listSidebar`; resolves `null` when the backend does not know the
 * command (or errors) so callers fall back to deriving the list locally.
 *
 * In `SidebarItem`, `member.member_id` and `members_preview[].member_id` are
 * persistent cross-space bot identity IDs (`collaboration_members.id`), whereas
 * `space.listMembers` returns per-space seat row UUIDs in `member_id`.
 */
export async function loadSidebarItems(
  collab: CollaborationCaller,
  workspaceId: string
): Promise<SidebarItem[] | null> {
  try {
    const page = await collab<{ items?: SidebarItem[] }>(
      'collaboration',
      'thread.listSidebar',
      { workspaceId }
    );
    return Array.isArray(page?.items) ? page.items : null;
  } catch {
    return null;
  }
}

/**
 * Enrich `space.listMembers` seat records with their persistent cross-space
 * `identity_member_id` (`collaboration_members.id`) resolved from sidebar items
 * (`thread.listSidebar`), matching by `conversation_id`, `identity_member_id`,
 * or normalized `nickname`.
 */
export function attachSidebarIdentityIds(
  members: readonly SpaceMember[],
  sidebarItems: readonly SidebarItem[] | null | undefined
): SpaceMember[] {
  if (!sidebarItems || sidebarItems.length === 0) {
    return [...members];
  }
  const identityByConvId = new Map<string, string>();
  const identityByNickname = new Map<string, string>();

  const indexSidebarMember = (
    m:
      | {
          member_id?: string | null;
          identity_member_id?: string | null;
          conversation_id?: string | null;
          name?: string | null;
        }
      | null
      | undefined
  ) => {
    if (!m) return;
    const identityId = resolveMemberIdentityId(m);
    if (!identityId) return;
    const convId = String(m.conversation_id ?? '').trim();
    if (convId && !identityByConvId.has(convId)) {
      identityByConvId.set(convId, identityId);
    }
    const nickKey = normalizeMemberNickname(m.name);
    if (nickKey && !identityByNickname.has(nickKey)) {
      identityByNickname.set(nickKey, identityId);
    }
  };

  for (const item of sidebarItems) {
    indexSidebarMember(item.member);
    for (const preview of item.members_preview ?? []) {
      indexSidebarMember(preview);
    }
  }

  return members.map((member) => {
    if (member.identity_member_id) return member;
    if (member.kind && member.kind !== 'agent') return member;
    const convId = String(member.conversation_id ?? '').trim();
    const nickKey = normalizeMemberNickname(member.nickname);
    const resolvedIdentity =
      (convId ? identityByConvId.get(convId) : undefined) ||
      (nickKey ? identityByNickname.get(nickKey) : undefined);
    if (!resolvedIdentity) return member;
    return {
      ...member,
      identity_member_id: resolvedIdentity,
    };
  });
}

function threadTarget(id: string): { threadId: string } | { spaceId: string } {
  return id.startsWith('direct:') ? { threadId: id } : { spaceId: id };
}

/** `thread.markRead`; best effort, never throws. */
export async function markThreadRead(
  collab: CollaborationCaller,
  id: string,
  seq?: number
): Promise<boolean> {
  try {
    await collab('collaboration', 'thread.markRead', {
      ...threadTarget(id),
      ...(typeof seq === 'number' ? { seq } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** `thread.markUnread`; best effort, never throws. */
export async function markThreadUnread(
  collab: CollaborationCaller,
  id: string
): Promise<boolean> {
  try {
    await collab('collaboration', 'thread.markUnread', threadTarget(id));
    return true;
  } catch {
    return false;
  }
}

/** `thread.update` tag colour ('' clears). False means use the local fallback. */
export async function updateThreadTagColor(
  collab: CollaborationCaller,
  id: string,
  tagColor: string
): Promise<boolean> {
  try {
    await collab('collaboration', 'thread.update', {
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
  collab: CollaborationCaller,
  memberId: string,
  threadId: string
): Promise<string | null> {
  try {
    const result = await collab<{ conversationId?: string }>(
      'collaboration',
      'member.session.resolve',
      { memberId, threadId }
    );
    return result?.conversationId || null;
  } catch {
    return null;
  }
}

export type DirectMessagePage<M> = { messages: M[] };

/** `space.listMessages` for a private chat (`direct:<id>`); null on failure.
 * Always a latest page: queued `conversation_input` rows and later
 * UserTurnCreated events must be grouped together or the IM duplicates
 * the user bubble / loses delivery receipts.
 */
export async function loadDirectMessages<M>(
  collab: CollaborationCaller,
  threadId: string,
  _sinceSeq?: number
): Promise<DirectMessagePage<M> | null> {
  try {
    const page = await collab<{ messages?: M[] }>(
      'collaboration',
      'space.listMessages',
      { spaceId: threadId, latest: true, limit: 200 }
    );
    return Array.isArray(page?.messages) ? { messages: page.messages } : null;
  } catch {
    return null;
  }
}

/** `space.post` to a private chat. `to` fans the mention out to other bots. */
export async function postDirectMessage(
  collab: CollaborationCaller,
  threadId: string,
  content: string,
  operationId: string,
  to?: readonly string[]
): Promise<{ seq?: number }> {
  const result = await collab<{ seq?: number } | null>(
    'collaboration',
    'space.post',
    {
      spaceId: threadId,
      content,
      operationId,
      ...(to && to.length > 0 ? { to: [...to] } : {}),
    }
  );
  return result ?? {};
}
