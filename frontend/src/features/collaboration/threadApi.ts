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
export type SidebarPage = {
  items: SidebarItem[] | null;
  /** Authoritative workspace Supervisor (`collaboration_members.id`), null when unset. */
  supervisorMemberId: string | null;
};

/**
 * `thread.listSidebar` with its workspace-level Supervisor identity; the page
 * carries `supervisor_member_id`, which stays correct even when an item payload
 * omits per-member `is_supervisor`.
 */
export async function loadSidebarPage(
  collab: CollaborationCaller,
  workspaceId: string
): Promise<SidebarPage> {
  try {
    const page = await collab<{
      items?: SidebarItem[];
      supervisor_member_id?: string | null;
      supervisorMemberId?: string | null;
    }>('collaboration', 'thread.listSidebar', { workspaceId });
    return {
      items: Array.isArray(page?.items) ? page.items : null,
      supervisorMemberId:
        page?.supervisor_member_id ?? page?.supervisorMemberId ?? null,
    };
  } catch {
    return { items: null, supervisorMemberId: null };
  }
}

export async function loadSidebarItems(
  collab: CollaborationCaller,
  workspaceId: string
): Promise<SidebarItem[] | null> {
  return (await loadSidebarPage(collab, workspaceId)).items;
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
  const supervisorByIdentity = new Map<string, boolean>();

  const indexSidebarMember = (
    m:
      | {
          member_id?: string | null;
          identity_member_id?: string | null;
          conversation_id?: string | null;
          name?: string | null;
          is_supervisor?: boolean;
        }
      | null
      | undefined
  ) => {
    if (!m) return;
    const identityId = resolveMemberIdentityId(m);
    if (!identityId) return;
    if (typeof m.is_supervisor === 'boolean') {
      supervisorByIdentity.set(identityId, m.is_supervisor);
    }
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
    if (member.kind && member.kind !== 'agent') return member;
    const convId = String(member.conversation_id ?? '').trim();
    const nickKey = normalizeMemberNickname(member.nickname);
    const resolvedIdentity =
      member.identity_member_id ||
      (convId ? identityByConvId.get(convId) : undefined) ||
      (nickKey ? identityByNickname.get(nickKey) : undefined);
    if (!resolvedIdentity) return member;
    const supervisorFlag = supervisorByIdentity.get(resolvedIdentity);
    return {
      ...member,
      identity_member_id: resolvedIdentity,
      ...(typeof supervisorFlag === 'boolean'
        ? { is_supervisor: supervisorFlag }
        : {}),
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

export type DirectMessagePage<M> = { messages: M[]; cards?: unknown[] };

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
    const page = await collab<{ messages?: M[]; cards?: unknown[] }>(
      'collaboration',
      'space.listMessages',
      { spaceId: threadId, latest: true, limit: 200 }
    );
    return Array.isArray(page?.messages)
      ? {
          messages: page.messages,
          ...(Array.isArray(page?.cards) ? { cards: page.cards } : {}),
        }
      : null;
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
  to?: readonly string[],
  inReplyTo?: string | null
): Promise<{ seq?: number }> {
  const result = await collab<{ seq?: number } | null>(
    'collaboration',
    'space.post',
    {
      spaceId: threadId,
      content,
      operationId,
      ...(to && to.length > 0 ? { to: [...to] } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
    }
  );
  return result ?? {};
}

export type SpaceReactionRecord = {
  emoji: string;
  actor: string;
};

/** Toggle the current user's emoji reaction on a space or DM message. */
export async function reactToSpaceMessage(
  collab: CollaborationCaller,
  spaceId: string,
  messageId: string,
  emoji: string
): Promise<SpaceReactionRecord[]> {
  const result = await collab<{ reactions?: SpaceReactionRecord[] } | null>(
    'collaboration',
    'space.react',
    { spaceId, messageId, emoji }
  );
  return Array.isArray(result?.reactions) ? result.reactions : [];
}

/**
 * Set or clear (`memberId: null`) the workspace Supervisor (主管) bot.
 * Returns the updated supervisor `member_id` (or `null` when cleared).
 */
export async function setWorkspaceSupervisor(
  collab: CollaborationCaller,
  workspaceId: string,
  memberId: string | null
): Promise<string | null> {
  const result = await collab<{
    supervisor_member_id?: string | null;
    supervisorMemberId?: string | null;
  } | null>('collaboration', 'member.setSupervisor', { workspaceId, memberId });
  return result?.supervisor_member_id ?? result?.supervisorMemberId ?? null;
}
