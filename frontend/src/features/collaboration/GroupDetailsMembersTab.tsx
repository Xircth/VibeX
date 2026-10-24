import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { collaborationCall } from './collaborationApi';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import {
  COPY,
  agentRoster,
  displayName,
  surfaceErrorCopy,
  unassignedSpaceId,
  type SidebarItem,
  type SpaceMember,
} from './spaceModel';

export const COLLABORATION_ADD_MEMBER_EVENT = 'vibex:collaboration-add-member';

export function requestCreateAssistantForSpace(spaceId: string) {
  window.dispatchEvent(
    new CustomEvent(COLLABORATION_ADD_MEMBER_EVENT, { detail: { spaceId } })
  );
}

export function GroupDetailsMembersTab({
  spaceId,
  workspaceId,
  getAvatar,
}: {
  spaceId: string;
  workspaceId?: string;
  getAvatar: (
    conversationId?: string | null,
    nickname?: string
  ) => MemberBotAvatarConfig;
}) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [candidates, setCandidates] = useState<
    { conversationId: string; name: string }[]
  >([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionError, setActionError] = useState('');

  const loadMembers = useCallback(async () => {
    if (!spaceId) return;
    const page = await collaborationCall<{ members?: SpaceMember[] }>(
      'collaboration',
      'space.listMembers',
      { spaceId }
    );
    setMembers(agentRoster(page.members ?? []));
  }, [spaceId]);

  useEffect(() => {
    void loadMembers().catch(() => setMembers([]));
  }, [loadMembers]);

  const memberConvIds = useMemo(() => {
    const ids = new Set<string>();
    for (const member of members) {
      const id = String(member.conversation_id ?? '').trim();
      if (id) ids.add(id);
    }
    return ids;
  }, [members]);

  const loadCandidates = useCallback(async () => {
    if (!workspaceId) {
      setCandidates([]);
      return;
    }
    const page = await collaborationCall<{ items?: SidebarItem[] }>(
      'collaboration',
      'thread.listSidebar',
      { workspaceId }
    );
    const next: { conversationId: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const item of page.items ?? []) {
      if (item.kind !== 'dm') continue;
      const conversationId = String(item.member?.conversation_id ?? '').trim();
      if (!conversationId || memberConvIds.has(conversationId)) continue;
      if (seen.has(conversationId)) continue;
      seen.add(conversationId);
      next.push({
        conversationId,
        name: item.member?.name || item.name || conversationId,
      });
    }
    setCandidates(next);
  }, [memberConvIds, workspaceId]);

  const removeMember = async (member: SpaceMember) => {
    const conversationId = String(member.conversation_id ?? '').trim();
    if (!conversationId || !workspaceId) return;
    setActionError('');
    try {
      await collaborationCall('collaboration', 'space.moveMember', {
        fromSpaceId: spaceId,
        toSpaceId: unassignedSpaceId(workspaceId),
        conversationId,
        nickname: displayName(member),
        operationId: crypto.randomUUID(),
      });
      await loadMembers();
    } catch (cause) {
      setActionError(surfaceErrorCopy(cause));
    }
  };

  const addMember = async (conversationId: string, name: string) => {
    setActionError('');
    try {
      await collaborationCall('collaboration', 'space.addMember', {
        spaceId,
        conversationId,
        nickname: name,
        operationId: crypto.randomUUID(),
      });
      setPickerOpen(false);
      await loadMembers();
    } catch (cause) {
      setActionError(surfaceErrorCopy(cause));
    }
  };

  return (
    <div
      className="collaboration-group-members"
      data-testid="collaboration-group-members-tab"
    >
      {members.map((member) => {
        const nick = displayName(member);
        const convId = member.conversation_id ?? '';
        return (
          <div
            key={member.member_id ?? convId ?? nick}
            className="collaboration-group-member-row"
            data-testid={`collaboration-group-member-${nick}`}
          >
            <MemberBotAvatar
              config={getAvatar(convId, nick)}
              className="h-7 w-7 shrink-0"
            />
            <span className="collaboration-group-member-name">{nick}</span>
            <Button
              type="button"
              variant="destructive"
              size="xs"
              className="collaboration-group-member-remove border-transparent bg-destructive/10 hover:bg-destructive/15"
              aria-label={`${COPY.removeSpaceMember} ${nick}`}
              onClick={() => {
                void removeMember(member);
              }}
            >
              {COPY.removeSpaceMember}
            </Button>
          </div>
        );
      })}
      <Popover
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (open) void loadCandidates();
        }}
      >
        <div className="collaboration-group-add-member-wrap">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="collaboration-group-add-member"
              data-testid="collaboration-group-add-member"
              icon={<Plus className="h-4 w-4" aria-hidden="true" />}
            >
              {COPY.addSpaceMember}
            </Button>
          </PopoverTrigger>
        </div>
        <PopoverContent align="center" className="w-56 p-1">
          <div className="collaboration-group-candidate-list">
            {candidates.map((candidate) => (
              <button
                key={candidate.conversationId}
                type="button"
                className="collaboration-group-member-row"
                data-testid={`collaboration-group-add-candidate-${candidate.name}`}
                onClick={() => {
                  void addMember(candidate.conversationId, candidate.name);
                }}
              >
                <MemberBotAvatar
                  config={getAvatar(candidate.conversationId, candidate.name)}
                  className="h-5 w-5 shrink-0"
                />
                <span className="collaboration-group-member-name">
                  {candidate.name}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="collaboration-group-create-assistant"
              data-testid="collaboration-group-create-assistant"
              onClick={() => {
                setPickerOpen(false);
                requestCreateAssistantForSpace(spaceId);
              }}
            >
              {COPY.createAssistantButton}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {actionError ? (
        <p className="collaboration-error px-1 pt-2 text-xs">{actionError}</p>
      ) : null}
    </div>
  );
}
