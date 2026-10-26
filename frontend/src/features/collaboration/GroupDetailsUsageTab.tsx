import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { SessionQuota } from '@/components/panels/session-details/SessionQuota';
import { buildSessionDetails } from '@/components/panels/session-details/sessionDetailsModel';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import { cn } from '@/lib/utils';
import { collaborationCall } from './collaborationApi';
import {
  aggregateTokenOverview,
  uniqueAgentIds,
  type MemberUsageSnapshot,
} from './groupDetailsUsage';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import { COPY, agentRoster, displayName, type SpaceMember } from './spaceModel';

const CARD_CLASS =
  'flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 shadow-none [--workspace-session-row-bg:var(--surface-card)]';

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCacheRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function memberUsageKey(member: SpaceMember): string {
  return member.member_id ?? member.conversation_id ?? displayName(member);
}

function GroupAgentQuotaCard({ agentId }: { agentId: string }) {
  const [quotaActive, setQuotaActive] = useState(false);
  return (
    <section
      className={cn(CARD_CLASS, !quotaActive && 'hidden')}
      hidden={!quotaActive}
      data-testid={`group-details-quota-card-${agentId}`}
    >
      <SessionQuota agentId={agentId} onActive={setQuotaActive} />
    </section>
  );
}

function GroupMemberUsageCard({
  member,
  getAvatar,
  onSnapshot,
}: {
  member: SpaceMember;
  getAvatar: (
    conversationId?: string | null,
    nickname?: string
  ) => MemberBotAvatarConfig;
  onSnapshot: (snapshot: MemberUsageSnapshot) => void;
}) {
  const nick = displayName(member);
  const memberKey = memberUsageKey(member);
  const conversationId = String(member.conversation_id ?? '').trim() || null;
  const cardRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [inViewport, setInViewport] = useState(true);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInViewport(entry.isIntersecting);
        }
      },
      { rootMargin: '120px' }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const shouldRetainTimeline = Boolean(conversationId && expanded && inViewport);
  const conversation = useConversationTimeline(
    shouldRetainTimeline ? conversationId : null,
    { active: shouldRetainTimeline }
  );
  const facts = useConversationSessionFacts(conversationId);
  const model = useMemo(
    () =>
      buildSessionDetails({
        facts,
        turns: conversation.timeline,
        sideRows: conversation.sideRows,
        branch: null,
        configOptions: conversation.sessionConfigOptions,
        currentTurnId: conversation.currentTurnId,
      }),
    [
      conversation.currentTurnId,
      conversation.sessionConfigOptions,
      conversation.sideRows,
      conversation.timeline,
      facts,
    ]
  );
  const usage = model.kind === 'ready' ? model.usage : null;
  const agentId =
    (model.kind === 'ready' ? model.agentId : null) || facts.agentId;
  const agentName = agentId ? getAgentName(agentId) : null;

  useEffect(() => {
    onSnapshot({
      memberKey,
      agentId,
      totalTokens: usage?.totalTokens ?? null,
      byModel:
        usage?.byModel.map((group) => ({
          key: group.key,
          label: group.label,
          tokens: group.tokens,
        })) ?? [],
    });
  }, [agentId, memberKey, onSnapshot, usage]);

  return (
    <section
      ref={cardRef}
      className={CARD_CLASS}
      data-testid={`group-details-usage-${conversationId || nick}`}
      data-collapsed={expanded ? 'false' : 'true'}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        aria-expanded={expanded}
        aria-label={nick}
        onClick={() => setExpanded((open) => !open)}
      >
        <MemberBotAvatar
          config={getAvatar(conversationId, nick)}
          className="h-6 w-6 shrink-0"
        />
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {nick}
        </h3>
        {agentName ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {agentId ? (
              <AgentIcon agent={agentId} className="h-3.5 w-3.5" />
            ) : null}
            <span className="truncate">{agentName}</span>
          </span>
        ) : null}
      </button>
      {expanded && usage && usage.byModel.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {usage.byModel.map((group) => (
            <li
              key={group.key || 'unlabeled'}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {group.label ?? COPY.unlabeledModel}
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span>{formatTokens(group.tokens)}</span>
                {group.cacheRate != null ? (
                  <span className="text-muted-foreground">
                    {formatCacheRate(group.cacheRate)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function GroupDetailsUsageTab({
  spaceId,
  getAvatar,
}: {
  spaceId: string;
  getAvatar: (
    conversationId?: string | null,
    nickname?: string
  ) => MemberBotAvatarConfig;
}) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [snapshots, setSnapshots] = useState<
    Record<string, MemberUsageSnapshot>
  >({});

  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    void collaborationCall<{ members?: SpaceMember[] }>(
      'collaboration',
      'space.listMembers',
      { spaceId }
    )
      .then((page) => {
        if (active) setMembers(agentRoster(page.members ?? []));
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, [spaceId]);

  const onSnapshot = useCallback((snapshot: MemberUsageSnapshot) => {
    setSnapshots((prev) => {
      const current = prev[snapshot.memberKey];
      if (
        current &&
        current.agentId === snapshot.agentId &&
        current.totalTokens === snapshot.totalTokens &&
        current.byModel.length === snapshot.byModel.length &&
        current.byModel.every(
          (group, index) =>
            group.key === snapshot.byModel[index]?.key &&
            group.tokens === snapshot.byModel[index]?.tokens
        )
      ) {
        return prev;
      }
      return { ...prev, [snapshot.memberKey]: snapshot };
    });
  }, []);

  const liveSnapshots = useMemo(() => {
    const keys = new Set(members.map(memberUsageKey));
    return Object.values(snapshots).filter((snapshot) =>
      keys.has(snapshot.memberKey)
    );
  }, [members, snapshots]);

  const overview = useMemo(
    () => aggregateTokenOverview(liveSnapshots),
    [liveSnapshots]
  );
  const quotaAgentIds = useMemo(
    () => uniqueAgentIds(liveSnapshots),
    [liveSnapshots]
  );

  return (
    <div
      className="collaboration-group-details-usage"
      data-testid="collaboration-group-details-tab"
    >
      {members.length > 0 ? (
        <section
          className={CARD_CLASS}
          data-testid="group-details-token-overview"
        >
          <h3 className="text-sm font-semibold text-foreground">
            {COPY.tokenOverview}
          </h3>
          <div>
            <strong className="kanban-usage-stat__value block font-semibold tabular-nums text-foreground">
              {overview.totalTokens != null
                ? formatTokens(overview.totalTokens)
                : '\u2014'}
            </strong>
            <div className="mt-1 text-xs text-muted-foreground">
              {COPY.totalTokens}
            </div>
          </div>
          {overview.byModel.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {overview.byModel.map((group) => (
                <li
                  key={group.key || 'unlabeled'}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="min-w-0 truncate">
                    {group.label ?? COPY.unlabeledModel}
                  </span>
                  <span className="tabular-nums">
                    {formatTokens(group.tokens)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {members.map((member) => (
        <GroupMemberUsageCard
          key={memberUsageKey(member)}
          member={member}
          getAvatar={getAvatar}
          onSnapshot={onSnapshot}
        />
      ))}
      {quotaAgentIds.map((agentId) => (
        <GroupAgentQuotaCard key={agentId} agentId={agentId} />
      ))}
    </div>
  );
}
