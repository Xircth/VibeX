import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { backendListen } from '@/lib/backendTransport';
import { focusWorkspaceConversation } from '@/lib/focusConversation';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useUiPreferencesStore } from '@/stores/useUiPreferencesStore';
import { useWindowProjectsStore } from '@/stores/useWindowProjectsStore';

import {
  collaborationCall,
  listenCollaborationSpaceChanged,
} from './collaborationApi';
import type { AgentOption, RoleTemplate } from './CollaborationDialogs';
import {
  CollaborationWorkspaceView,
  type PendingCard,
  type ProfileData,
} from './CollaborationWorkspaceView';
import type { GroupMessage, GroupSeat } from './GroupChat';
import type { MemberSessionConfig } from './MemberSessionConfigSection';
import { directReceipts } from './MemberDirectChat';
import {
  deriveMemberBotAvatar,
  readMemberBotAvatars,
  writeMemberBotAvatars,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import type { WriteAccess } from './MemberProfilePanel';
import {
  buildMemberSessionTab,
  closeMemberSessionTab,
  memberSessionTabKey,
  upsertMemberSessionTab,
  type MemberSessionTab,
} from './memberSessionTabs';
import {
  parseSpaceChangedEvent,
  surfaceErrorCopy,
  unassignedSpaceId,
} from './spaceModel';
import type { CardResolution } from './ThreadCards';
import {
  attentionByMember,
  buildThreadList,
  collectMembers,
  groupKey,
  memberKey,
  memberPresence,
  readThreadPins,
  togglePin,
  writeThreadPins,
  type ConversationFacts,
  type ReceiptInput,
  type ThreadActivity,
  type ThreadFilter,
  directChatNotices,
} from './threadModel';

export const COLLABORATION_RECEIPTS_CHANGED_EVENT =
  'vibex://collaboration-receipts-changed' as const;

type Space = { space_id: string; name: string; updated_at?: string };
type SeatRow = {
  member_id?: string;
  nickname?: string;
  kind?: string;
  conversation_id?: string | null;
};
type WireMessage = GroupMessage & { created_at?: string };

function newOperationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random()}`
  );
}

function cardResolution(card: PendingCard): CardResolution {
  const resolution = card.resolution ?? {};
  return {
    status: card.status === 'pending' ? 'pending' : 'resolved',
    decision:
      typeof resolution.decision === 'string' ? resolution.decision : null,
    answer: typeof resolution.answer === 'string' ? resolution.answer : null,
  };
}

export function CollaborationWorkspace({
  workspaceId,
  projectId,
  workspacePath,
}: {
  workspaceId: string | null;
  projectId?: string | null;
  workspacePath?: string;
}) {
  const workspace = workspaceId ?? '';
  const directSpaceId = workspace ? unassignedSpaceId(workspace) : '';
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [membersBySpace, setMembersBySpace] = useState<
    Record<string, SeatRow[]>
  >({});
  const [conversations, setConversations] = useState<
    Map<string, ConversationFacts>
  >(() => new Map());
  const [cards, setCards] = useState<PendingCard[]>([]);
  const [activity, setActivity] = useState<Record<string, ThreadActivity>>({});
  const [groupMessages, setGroupMessages] = useState<WireMessage[]>([]);
  const [receiptsBySeq, setReceiptsBySeq] = useState<
    Record<number, ReceiptInput[]>
  >({});
  const seqByMessageId = useRef(new Map<string, number>());
  const [pins, setPins] = useState<string[]>(() => readThreadPins());
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [dialogs, setDialogs] = useState({
    newGroup: false,
    newMember: false,
  });
  const [busy, setBusy] = useState(false);
  const [busyCardIds, setBusyCardIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [avatars, setAvatars] = useState(() => readMemberBotAvatars());
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  // Workspace-wide snapshot: groups, seats, sessions, pending cards.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await collaborationCall<{ spaces?: Space[] }>(
          'collaboration',
          'space.list',
          { workspaceId: workspace }
        );
        const groups = (page.spaces ?? []).filter(
          (s) => s.space_id !== directSpaceId
        );
        const ids = [directSpaceId, ...groups.map((s) => s.space_id)];
        const [seatPages, convPage, cardPages, latest] = await Promise.all([
          Promise.all(
            ids.map((spaceId) =>
              collaborationCall<{ members?: SeatRow[] }>(
                'collaboration',
                'space.listMembers',
                { spaceId }
              ).catch(() => ({ members: [] as SeatRow[] }))
            )
          ),
          collaborationCall<{ conversations?: ConversationFacts[] }>(
            'collaboration',
            'space.listConversations',
            { workspaceId: workspace }
          ).catch(() => ({ conversations: [] as ConversationFacts[] })),
          Promise.all(
            ids.map((spaceId) =>
              collaborationCall<{ cards?: PendingCard[] }>(
                'collaboration',
                'card.list',
                {
                  spaceId,
                  pendingOnly: true,
                }
              ).catch(() => ({ cards: [] as PendingCard[] }))
            )
          ),
          Promise.all(
            groups.map((space) =>
              collaborationCall<{ messages?: WireMessage[] }>(
                'collaboration',
                'space.listMessages',
                { spaceId: space.space_id, latest: true, limit: 1 }
              ).catch(() => ({ messages: [] as WireMessage[] }))
            )
          ),
        ]);
        if (cancelled) return;
        setSpaces(groups);
        const bySpace: Record<string, SeatRow[]> = {};
        ids.forEach((id, index) => {
          bySpace[id] = seatPages[index].members ?? [];
        });
        setMembersBySpace(bySpace);
        setConversations(
          new Map(
            (convPage.conversations ?? []).map((c) => [c.conversation_id, c])
          )
        );
        setCards(cardPages.flatMap((p) => p.cards ?? []));
        const nextActivity: Record<string, ThreadActivity> = {};
        groups.forEach((space, index) => {
          const last = latest[index].messages?.at(-1);
          nextActivity[groupKey(space.space_id)] = {
            at: last?.created_at ?? space.updated_at ?? null,
            text: last?.envelope.summary || last?.envelope.content || null,
          };
        });
        setActivity((current) => ({ ...current, ...nextActivity }));
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(surfaceErrorCopy(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directSpaceId, reloadToken, workspace]);

  useEffect(() => {
    void collaborationCall<{ roles?: RoleTemplate[] }>(
      'collaboration',
      'role.list'
    )
      .then((page) => setRoles(page.roles ?? []))
      .catch(() => setRoles([]));
    void collaborationCall<{ agents?: AgentOption[] }>(
      'collaboration',
      'role.agents'
    )
      .then((page) => setAgents(page.agents ?? []))
      .catch(() => setAgents([]));
  }, []);

  const { members, groups } = useMemo(
    () => collectMembers(spaces, membersBySpace, directSpaceId),
    [directSpaceId, membersBySpace, spaces]
  );

  // Member rows: latest session update stands in for the latest message.
  const memberActivity = useMemo(() => {
    const out: Record<string, ThreadActivity> = {};
    for (const member of members) {
      const latest = member.seats
        .map(
          (seat) =>
            conversations.get(seat.conversationId ?? '')?.updated_at ?? ''
        )
        .sort()
        .at(-1);
      out[memberKey(member.memberId)] = { at: latest || null };
    }
    return out;
  }, [conversations, members]);

  const queuedByConversation = useMemo(() => {
    const counts = new Map<string, number>();
    for (const list of Object.values(receiptsBySeq)) {
      for (const receipt of list) {
        if (receipt.state !== 'queued' || !receipt.conversation_id) continue;
        counts.set(
          receipt.conversation_id,
          (counts.get(receipt.conversation_id) ?? 0) + 1
        );
      }
    }
    return counts;
  }, [receiptsBySeq]);

  const attention = useMemo(() => attentionByMember(cards), [cards]);
  const mergedActivity = useMemo(
    () => ({ ...activity, ...memberActivity }),
    [activity, memberActivity]
  );
  const allItems = useMemo(
    () =>
      buildThreadList({
        members,
        groups,
        conversations,
        activity: mergedActivity,
        pins,
        attentionByMember: attention,
        queuedByConversation,
      }),
    [
      attention,
      conversations,
      groups,
      members,
      mergedActivity,
      pins,
      queuedByConversation,
    ]
  );
  const items = useMemo(
    () =>
      buildThreadList({
        members,
        groups,
        conversations,
        activity: mergedActivity,
        pins,
        attentionByMember: attention,
        queuedByConversation,
        filter,
        query,
      }),
    [
      attention,
      conversations,
      filter,
      groups,
      members,
      mergedActivity,
      pins,
      query,
      queuedByConversation,
    ]
  );

  useEffect(() => {
    if (selectedKey && allItems.some((item) => item.key === selectedKey))
      return;
    setSelectedKey(allItems[0]?.key ?? null);
  }, [allItems, selectedKey]);

  const selectedMember = selectedKey?.startsWith('member:')
    ? (members.find((m) => memberKey(m.memberId) === selectedKey) ?? null)
    : null;
  const selectedGroup = selectedKey?.startsWith('group:')
    ? (groups.find((g) => groupKey(g.spaceId) === selectedKey) ?? null)
    : null;
  const directConversationId =
    selectedMember?.seats.find((seat) => seat.direct)?.conversationId ?? null;

  const timeline = useConversationTimeline(directConversationId, {
    active: Boolean(directConversationId),
  });
  const directTurns = useMemo(
    () =>
      (timeline.timeline ?? []).map((row) => ({
        key: row.key,
        turn: row.turn,
        phase: row.phase,
      })),
    [timeline.timeline]
  );
  const directInFlight = Boolean(
    conversations.get(directConversationId ?? '')?.turn_in_flight
  );
  const liveDirect = useMemo<Record<string, never>>(() => ({}), []);
  const directReceiptStates = useMemo(
    () => directReceipts(directTurns, liveDirect, directInFlight),
    [directInFlight, directTurns, liveDirect]
  );

  // Selected group transcript.
  const selectedSpaceId = selectedGroup?.spaceId ?? '';
  const loadGroup = useCallback(async () => {
    if (!selectedSpaceId) return;
    const page = await collaborationCall<{ messages?: WireMessage[] }>(
      'collaboration',
      'space.listMessages',
      { spaceId: selectedSpaceId, latest: true, limit: 200 }
    );
    setGroupMessages(page.messages ?? []);
  }, [selectedSpaceId]);
  useEffect(() => {
    setGroupMessages([]);
    void loadGroup().catch((cause) => setError(surfaceErrorCopy(cause)));
  }, [loadGroup]);

  const directViewer = selectedMember?.nickname ?? '';
  // Member-to-member traffic in the direct-chat space, for cross-DM lines.
  const [directSpaceMessages, setDirectSpaceMessages] = useState<WireMessage[]>(
    []
  );
  const loadDirectSpace = useCallback(async () => {
    if (!directViewer || !directSpaceId) return;
    const page = await collaborationCall<{ messages?: WireMessage[] }>(
      'collaboration',
      'space.listMessages',
      { spaceId: directSpaceId, latest: true, limit: 200 }
    );
    setDirectSpaceMessages(page.messages ?? []);
  }, [directSpaceId, directViewer]);
  useEffect(() => {
    void loadDirectSpace().catch(() => undefined);
  }, [loadDirectSpace, reloadToken]);
  const directNotices = useMemo(
    () => directChatNotices(directViewer, directSpaceMessages),
    [directSpaceMessages, directViewer]
  );

  const [threadCards, setThreadCards] = useState<PendingCard[]>([]);
  useEffect(() => {
    const spaceId = selectedSpaceId || (selectedMember ? directSpaceId : '');
    if (!spaceId) return;
    let cancelled = false;
    void collaborationCall<{ cards?: PendingCard[] }>(
      'collaboration',
      'card.list',
      {
        spaceId,
      }
    )
      .then((page) => {
        if (!cancelled) setThreadCards(page.cards ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [directSpaceId, reloadToken, selectedMember, selectedSpaceId]);
  const cardStatus = useMemo(() => {
    const out: Record<string, CardResolution> = {};
    for (const card of [...threadCards, ...cards])
      out[card.id] = cardResolution(card);
    return out;
  }, [cards, threadCards]);

  // Live updates.
  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    void listenCollaborationSpaceChanged((payload) => {
      const event = parseSpaceChangedEvent(payload);
      if (event && event.workspaceId && event.workspaceId !== workspace) return;
      reload();
      if (event?.spaceId && event.spaceId === selectedSpaceId) void loadGroup();
    }).then((stop) => (disposed ? stop() : stops.push(stop)));
    void backendListen(COLLABORATION_RECEIPTS_CHANGED_EVENT, (payload) => {
      const record = (payload ?? {}) as {
        messageId?: string;
        receipts?: ReceiptInput[];
      };
      const seq = seqByMessageId.current.get(String(record.messageId ?? ''));
      if (seq == null || !Array.isArray(record.receipts)) return;
      setReceiptsBySeq((current) => ({
        ...current,
        [seq]: record.receipts ?? [],
      }));
    }).then((stop) => (disposed ? stop() : stops.push(stop)));
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [loadGroup, reload, selectedSpaceId, workspace]);

  // Profile data for the selected member.
  const selectedMemberId = selectedMember?.memberId ?? '';
  useEffect(() => {
    if (!profileOpen || !selectedMemberId) return;
    let cancelled = false;
    void Promise.all([
      collaborationCall<{ facts?: ProfileData['facts'] }>(
        'collaboration',
        'member.memory.list',
        { memberId: selectedMemberId }
      ).catch(() => ({ facts: [] })),
      collaborationCall<{
        activity?: Array<{
          id: string;
          thread_id?: string | null;
          summary: string;
          private?: boolean;
          created_at?: string;
        }>;
      }>('collaboration', 'member.activity.list', {
        memberId: selectedMemberId,
      }).catch(() => ({ activity: [] })),
      collaborationCall<{ config?: MemberSessionConfig | null }>(
        'collaboration',
        'member.config.get',
        { memberId: selectedMemberId }
      ).catch(() => ({ config: null })),
    ]).then(([memory, act, cfg]) => {
      if (cancelled) return;
      setProfile((current) => ({
        facts: memory.facts ?? [],
        activity: (act.activity ?? []).map((row) => ({
          id: row.id,
          threadId: row.thread_id ?? null,
          summary: row.summary,
          private: row.private,
          createdAt: row.created_at,
        })),
        writeAccess: current?.writeAccess ?? 'write_isolated',
        sessionConfig: cfg.config ?? null,
        agentLabel:
          conversations.get(directConversationId ?? '')?.agent_id ?? undefined,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    conversations,
    directConversationId,
    profileOpen,
    reloadToken,
    selectedMemberId,
  ]);

  const avatarFor = useCallback(
    (memberId: string, nickname: string): MemberBotAvatarConfig =>
      avatars[memberId] ??
      avatars[nickname] ??
      deriveMemberBotAvatar(memberId || nickname),
    [avatars]
  );

  const groupSeats: GroupSeat[] = useMemo(() => {
    if (!selectedGroup) return [];
    return selectedGroup.memberIds.flatMap((memberId) => {
      const member = members.find((m) => m.memberId === memberId);
      if (!member) return [];
      const seat = member.seats.find(
        (s) => s.threadId === selectedGroup.spaceId
      );
      const presence = memberPresence(
        member,
        conversations,
        queuedByConversation
      );
      const elsewhere = presence.busyThreads.find(
        (name) => name !== selectedGroup.name
      );
      return [
        {
          memberId,
          nickname: member.nickname,
          conversationId: seat?.conversationId ?? null,
          avatar: avatarFor(memberId, member.nickname),
          presence,
          busyElsewhere:
            presence.state === 'busy' &&
            !conversations.get(seat?.conversationId ?? '')?.turn_in_flight
              ? elsewhere || '私聊'
              : null,
        },
      ];
    });
  }, [avatarFor, conversations, members, queuedByConversation, selectedGroup]);

  const messagesWithReceipts: GroupMessage[] = useMemo(
    () =>
      groupMessages.map((message) =>
        receiptsBySeq[message.seq]
          ? {
              ...message,
              receipts: receiptsBySeq[message.seq].map((r) => ({
                ...r,
                nickname:
                  groupSeats.find((s) => s.conversationId === r.conversation_id)
                    ?.nickname ?? r.nickname,
              })),
            }
          : message
      ),
    [groupMessages, groupSeats, receiptsBySeq]
  );

  const threadNames = useMemo(
    () => new Map(groups.map((g) => [g.spaceId, g.name])),
    [groups]
  );

  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
      setError(null);
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const submit = useCallback(
    async (spaceId: string, content: string, to: string[]) => {
      const result = await collaborationCall<{
        messageId?: string;
        seq?: number;
        receipts?: ReceiptInput[];
      }>('collaboration', 'space.submit', {
        spaceId,
        content,
        to,
        operationId: newOperationId(),
      });
      if (typeof result.seq === 'number') {
        if (result.messageId)
          seqByMessageId.current.set(result.messageId, result.seq);
        setReceiptsBySeq((current) => ({
          ...current,
          [result.seq as number]: result.receipts ?? [],
        }));
      }
    },
    []
  );

  const openSession = useCallback(
    (conversationId: string) => {
      if (!projectId || !workspace) return;
      const focused = focusWorkspaceConversation({
        projectId,
        workspaceId: workspace,
        conversationId,
      });
      useUiPreferencesStore.getState().setLayoutMode('workspaces');
      useLayoutStore.getState().setActiveTab('workspace');
      useWindowProjectsStore.getState().ensureProjectOpen(projectId);
      navigate(focused.path);
    },
    [navigate, projectId, workspace]
  );

  const [sessionTabs, setSessionTabs] = useState<MemberSessionTab[]>([]);
  const [activeSessionTabKey, setActiveSessionTabKey] = useState<
    string | null
  >(null);
  const sessionTabsRef = useRef(sessionTabs);
  sessionTabsRef.current = sessionTabs;
  const resolvingTabs = useRef(new Set<string>());

  /** Avatar click: the member's session for THIS thread, never "latest". */
  const openMemberSession = useCallback(
    async (memberId: string, threadId: string) => {
      const key = memberSessionTabKey(memberId, threadId);
      setProfileOpen(false);
      if (sessionTabsRef.current.some((tab) => tab.key === key)) {
        setActiveSessionTabKey(key);
        return;
      }
      if (resolvingTabs.current.has(key)) return;
      resolvingTabs.current.add(key);
      try {
        const result = await collaborationCall<{ conversationId?: string }>(
          'collaboration',
          'member.session.resolve',
          { memberId, threadId }
        );
        if (!result.conversationId) return;
        const tab = buildMemberSessionTab({
          memberId,
          threadId,
          conversationId: result.conversationId,
          members,
          groups,
          avatarFor,
        });
        setSessionTabs((current) => upsertMemberSessionTab(current, tab));
        setActiveSessionTabKey(key);
        setError(null);
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      } finally {
        resolvingTabs.current.delete(key);
      }
    },
    [avatarFor, groups, members]
  );

  const createMember = useCallback(
    async (input: {
      nickname: string;
      source?: 'role' | 'custom';
      roleId?: string;
      agentId?: string;
      modeId?: string;
      configValues?: Record<string, string>;
      personaPrompt?: string;
      persona?: string;
    }) => {
      const result = await collaborationCall<{
        member_id?: string;
        conversation_id?: string | null;
      }>('collaboration', 'space.createMember', {
        workspaceId: workspace,
        nickname: input.nickname,
        source: input.source ?? (input.roleId ? 'role' : 'custom'),
        ...(input.roleId
          ? { roleId: input.roleId }
          : {
              agentId: input.agentId,
              modeId: input.modeId,
              configValues: input.configValues,
              personaPrompt: input.personaPrompt ?? input.persona,
            }),
        operationId: newOperationId(),
      });
      return result.member_id ?? null;
    },
    [workspace]
  );

  return (
    <CollaborationWorkspaceView
      items={items}
      allItems={allItems}
      members={members}
      selectedKey={selectedKey}
      filter={filter}
      query={query}
      avatarFor={avatarFor}
      directTurns={directTurns}
      directNotices={directNotices}
      directReceipts={directReceiptStates}
      groupSeats={groupSeats}
      groupMessages={messagesWithReceipts}
      cards={cards}
      cardStatus={cardStatus}
      busyCardIds={busyCardIds}
      profileOpen={profileOpen}
      profile={profile}
      threadNames={threadNames}
      roles={roles}
      agents={agents}
      dialogs={dialogs}
      busy={busy}
      workspacePath={workspacePath}
      workspaceId={workspace}
      error={error}
      onFilterChange={setFilter}
      onQueryChange={setQuery}
      onSelect={(key) => {
        setSelectedKey(key);
        if (!key.startsWith('member:')) setProfileOpen(false);
      }}
      onTogglePin={(key) =>
        setPins((current) => {
          const next = togglePin(current, key);
          writeThreadPins(next);
          return next;
        })
      }
      onDialogChange={(dialog, open) => {
        setDialogs((current) => ({ ...current, [dialog]: open }));
      }}
      onCreateGroup={(name, memberIds) =>
        void run(async () => {
          const created = await collaborationCall<Partial<Space>>(
            'collaboration',
            'space.create',
            { workspaceId: workspace, name, operationId: newOperationId() }
          );
          const spaceId = created.space_id;
          if (!spaceId) return;
          for (const memberId of memberIds) {
            const member = members.find((m) => m.memberId === memberId);
            const conversationId = member?.seats.find(
              (s) => s.direct
            )?.conversationId;
            if (!member || !conversationId) continue;
            await collaborationCall('collaboration', 'space.addMember', {
              spaceId,
              conversationId,
              nickname: member.nickname,
              operationId: newOperationId(),
            });
          }
          setDialogs((d) => ({ ...d, newGroup: false }));
          setSelectedKey(groupKey(spaceId));
          reload();
        })
      }
      onCreateMember={(input) =>
        void run(async () => {
          const memberId = await createMember(input);
          setAvatars((current) => {
            const next = { ...current, [input.nickname]: input.avatar };
            if (memberId) next[memberId] = input.avatar;
            writeMemberBotAvatars(next);
            return next;
          });
          setDialogs((d) => ({ ...d, newMember: false }));
          if (memberId) setSelectedKey(memberKey(memberId));
          reload();
        })
      }
      onSendDirect={(content) =>
        void run(async () => {
          if (!selectedMember) return;
          await submit(directSpaceId, content, [selectedMember.nickname]);
        })
      }
      onSendGroup={async (content, to) => {
        if (!selectedSpaceId) return;
        await submit(selectedSpaceId, content, to);
        await loadGroup();
      }}
      onPreviewWake={async (content) => {
        const preview = await collaborationCall<{
          will_wake?: number;
          asleep?: number;
        }>('collaboration', 'space.wakePreview', {
          spaceId: selectedSpaceId,
          content,
          to: [],
        });
        return {
          willWake: preview.will_wake ?? 0,
          asleep: preview.asleep ?? 0,
        };
      }}
      onResolveCard={(cardId, decision, answer) => {
        setBusyCardIds((current) => new Set(current).add(cardId));
        const card = [...cards, ...threadCards].find((c) => c.id === cardId);
        void collaborationCall('collaboration', 'card.resolve', {
          cardId,
          ...(card?.kind === 'ask' ? { answer } : { decision, note: answer }),
        })
          .then(() => reload())
          .catch((cause) => setError(surfaceErrorCopy(cause)))
          .finally(() =>
            setBusyCardIds((current) => {
              const next = new Set(current);
              next.delete(cardId);
              return next;
            })
          );
      }}
      onOpenSession={openSession}
      onToggleProfile={setProfileOpen}
      onOpenMemberSession={(memberId, threadId) =>
        void openMemberSession(memberId, threadId)
      }
      sessionTabs={sessionTabs}
      activeSessionTabKey={activeSessionTabKey}
      onActivateSessionTab={setActiveSessionTabKey}
      onCloseSessionTab={(key) => {
        const next = closeMemberSessionTab(
          sessionTabsRef.current,
          activeSessionTabKey,
          key
        );
        setSessionTabs(next.tabs);
        setActiveSessionTabKey(next.activeKey);
      }}
      onUpdateFact={(factId, content) =>
        void run(async () => {
          const fact = profile?.facts.find((f) => f.id === factId);
          await collaborationCall('collaboration', 'member.memory.update', {
            memberId: selectedMemberId,
            factId,
            content,
            scope: fact?.scope,
          });
          reload();
        })
      }
      onDeleteFact={(factId) =>
        void run(async () => {
          await collaborationCall('collaboration', 'member.memory.delete', {
            memberId: selectedMemberId,
            factId,
          });
          reload();
        })
      }
      onSaveSessionConfig={(next) =>
        void run(async () => {
          const saved = await collaborationCall<{
            config?: MemberSessionConfig | null;
          }>('collaboration', 'member.config.update', {
            memberId: selectedMemberId,
            ...next,
          });
          setProfile((current) =>
            current
              ? { ...current, sessionConfig: saved.config ?? null }
              : current
          );
        })
      }
      onSetWriteAccess={(value: WriteAccess) =>
        void run(async () => {
          await collaborationCall('collaboration', 'member.setWriteAccess', {
            memberId: selectedMemberId,
            writeAccess: value,
          });
          setProfile((current) =>
            current ? { ...current, writeAccess: value } : current
          );
        })
      }
    />
  );
}
