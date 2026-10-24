import { useEffect, useMemo, useState } from 'react';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { SessionQuota } from '@/components/panels/session-details/SessionQuota';
import { buildSessionDetails } from '@/components/panels/session-details/sessionDetailsModel';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import { cn } from '@/lib/utils';
import { collaborationCall } from './collaborationApi';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import { agentRoster, displayName, type SpaceMember } from './spaceModel';

const CARD_CLASS =
  'flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 shadow-none [--workspace-session-row-bg:var(--surface-card)]';

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function GroupMemberUsageCard({
  member,
  getAvatar,
}: {
  member: SpaceMember;
  getAvatar: (
    conversationId?: string | null,
    nickname?: string
  ) => MemberBotAvatarConfig;
}) {
  const nick = displayName(member);
  const conversationId = String(member.conversation_id ?? '').trim() || null;
  const conversation = useConversationTimeline(conversationId);
  const facts = useConversationSessionFacts(conversationId);
  const [quotaActive, setQuotaActive] = useState(false);
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
  const modelLabel =
    (model.kind === 'ready' ? model.model : null) || facts.model;
  const agentId =
    (model.kind === 'ready' ? model.agentId : null) || facts.agentId;
  const agentName = agentId ? getAgentName(agentId) : null;

  return (
    <section
      className={CARD_CLASS}
      data-testid={`group-details-usage-${conversationId || nick}`}
    >
      <div className="flex items-center gap-2">
        <MemberBotAvatar
          config={getAvatar(conversationId, nick)}
          className="h-6 w-6 shrink-0"
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {nick}
        </h3>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">模型</dt>
        <dd className="min-w-0 truncate text-foreground">
          {modelLabel || '—'}
        </dd>
        {agentName ? (
          <>
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="flex min-w-0 items-center gap-1.5 text-foreground">
              {agentId ? (
                <AgentIcon agent={agentId} className="h-3.5 w-3.5" />
              ) : null}
              <span className="truncate">{agentName}</span>
            </dd>
          </>
        ) : null}
      </dl>
      {usage?.totalTokens != null ? (
        <div data-testid={`group-details-tokens-${conversationId || nick}`}>
          <strong className="kanban-usage-stat__value block font-semibold tabular-nums text-foreground">
            {formatTokens(usage.totalTokens)}
          </strong>
          <div className="mt-1 text-xs text-muted-foreground">总 Token</div>
        </div>
      ) : null}
      {usage && usage.byModel.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {usage.byModel.map((group) => (
            <li
              key={group.key || 'unlabeled'}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {group.label ?? '未标记模型'}
              </span>
              <span className="tabular-nums">{formatTokens(group.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={cn(!quotaActive && 'hidden')} hidden={!quotaActive}>
        <SessionQuota agentId={agentId} onActive={setQuotaActive} />
      </div>
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

  return (
    <div
      className="collaboration-group-details-usage"
      data-testid="collaboration-group-details-tab"
    >
      {members.map((member) => (
        <GroupMemberUsageCard
          key={
            member.member_id ?? member.conversation_id ?? displayName(member)
          }
          member={member}
          getAvatar={getAvatar}
        />
      ))}
    </div>
  );
}
