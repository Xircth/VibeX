import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationRelationView } from 'shared/types';

import { conversationApi } from '@/features/conversation/conversationApi';
import { listenToConversationEvents } from '@/features/conversation/events';
import { cn } from '@/lib/utils';

const inFlightRelationsByConversation = new Map<
  string,
  Promise<ConversationRelationView[]>
>();

function fetchConversationRelationsDeduplicated(
  conversationId: string
): Promise<ConversationRelationView[]> {
  const existing = inFlightRelationsByConversation.get(conversationId);
  if (existing) return existing;
  const request = conversationApi
    .listRelations(conversationId)
    .finally(() => {
      if (inFlightRelationsByConversation.get(conversationId) === request) {
        inFlightRelationsByConversation.delete(conversationId);
      }
    });
  inFlightRelationsByConversation.set(conversationId, request);
  return request;
}

export function areConversationRelationsEqual(
  left: ConversationRelationView[],
  right: ConversationRelationView[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.id !== b.id ||
      a.parentConversationId !== b.parentConversationId ||
      a.childConversationId !== b.childConversationId ||
      a.kind !== b.kind ||
      a.visibility !== b.visibility ||
      a.child.workspaceId !== b.child.workspaceId ||
      a.child.title !== b.child.title ||
      a.child.status !== b.child.status ||
      a.child.activeTurnStatus !== b.child.activeTurnStatus ||
      a.child.queuedInputCount !== b.child.queuedInputCount ||
      a.child.messageCount !== b.child.messageCount
    ) {
      return false;
    }
  }
  return true;
}

type DelegationBudgetSummary = {
  callsUsed: number;
  maxCalls: number;
  activeChildren: number;
  maxActiveChildren: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delegationPolicy(metadata: unknown): Record<string, unknown> | null {
  if (!isRecord(metadata) || !isRecord(metadata.policy)) return null;
  return metadata.policy;
}

export function summarizeConversationChildren(
  relations: ConversationRelationView[]
): {
  children: ConversationRelationView[];
  activeCount: number;
  waitingCount: number;
  budget: DelegationBudgetSummary | null;
} {
  const children = relations.filter(
    (relation) => relation.visibility === 'visible'
  );
  const activeCount = children.filter((relation) =>
    ['pending', 'queued', 'running', 'blocked'].includes(
      relation.child.activeTurnStatus ?? ''
    )
  ).length;
  const waitingCount = children.filter(
    (relation) => relation.child.activeTurnStatus === 'blocked'
  ).length;
  const delegations = children.filter(
    (relation) => relation.kind === 'delegation'
  );
  const policy = delegations
    .map((relation) => delegationPolicy(relation.metadata))
    .find(
      (candidate): candidate is Record<string, unknown> => candidate !== null
    );
  const maxCalls =
    policy && typeof policy.maxCallsPerParent === 'number'
      ? policy.maxCallsPerParent
      : null;
  const maxActiveChildren =
    policy && typeof policy.maxActiveChildren === 'number'
      ? policy.maxActiveChildren
      : null;

  return {
    children,
    activeCount,
    waitingCount,
    budget:
      maxCalls !== null && maxActiveChildren !== null
        ? {
            callsUsed: delegations.length,
            maxCalls,
            activeChildren: activeCount,
            maxActiveChildren,
          }
        : null,
  };
}

export function ConversationChildrenSummary({
  conversationId,
  onOpenChild,
}: {
  conversationId: string;
  onOpenChild?: (conversationId: string, workspaceId?: string) => void;
}) {
  const { t } = useTranslation('conversation');
  const [relations, setRelations] = useState<ConversationRelationView[]>([]);

  const load = useCallback(
    (isMounted: () => boolean) =>
      fetchConversationRelationsDeduplicated(conversationId)
        .then((next) => {
          if (!isMounted()) return;
          setRelations((prev) =>
            areConversationRelationsEqual(prev, next) ? prev : next
          );
        })
        .catch(() => undefined),
    [conversationId]
  );

  useEffect(() => {
    let active = true;
    const isMounted = () => active;
    void load(isMounted);

    let unlisten: (() => void) | undefined;
    listenToConversationEvents((batch) => {
      if (!active || batch.conversation_id !== conversationId) return;
      const ops = Array.isArray(batch.ops) ? batch.ops : [];
      if (ops.length > 0 && ops.every((op) => op.op === 'append_text')) {
        return;
      }
      void load(isMounted);
    }, conversationId)
      .then((unsubscribe) => {
        if (!active) {
          unsubscribe();
          return;
        }
        unlisten = unsubscribe;
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [conversationId, load]);

  const { children, activeCount, waitingCount, budget } = useMemo(
    () => summarizeConversationChildren(relations),
    [relations]
  );

  useEffect(() => {
    if (activeCount <= 0) return;
    let active = true;
    const isMounted = () => active;
    const interval = window.setInterval(() => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      void load(isMounted);
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeCount, load]);

  if (children.length === 0) return null;

  return (
    <section
      className="composer-status-row text-xs"
      data-tone="info"
      data-testid="conversation-children-summary"
      role="status"
    >
      <div className="composer-status-header">
        <div className="composer-status-heading">
          <p className="composer-status-title">
            {t('children.title', { count: children.length })}
          </p>
          {activeCount > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {t('children.active', { count: activeCount })}
            </span>
          ) : null}
          {waitingCount > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {t('children.waiting', { count: waitingCount })}
            </span>
          ) : null}
        </div>
        {budget ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('children.budget', {
              callsUsed: budget.callsUsed,
              maxCalls: budget.maxCalls,
              active: budget.activeChildren,
              maxActive: budget.maxActiveChildren,
            })}
          </span>
        ) : null}
      </div>
      <div className="mt-1 space-y-0.5">
        {children.map((relation) => {
          const title = relation.child.title || t('children.untitled');
          const open = onOpenChild
            ? () =>
                onOpenChild(
                  relation.childConversationId,
                  relation.child.workspaceId
                )
            : undefined;
          return (
            <button
              key={relation.id}
              type="button"
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-md px-0 py-1 text-left',
                open
                  ? 'hover:text-foreground'
                  : 'cursor-default text-muted-foreground'
              )}
              onClick={open}
              disabled={!open}
              aria-label={`${t('children.open')}: ${title}`}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {title}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t(`children.status.${relation.child.status}`)}
              </span>
              {relation.child.queuedInputCount > 0n ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t('children.queued', {
                    count: String(relation.child.queuedInputCount),
                  })}
                </span>
              ) : null}
              {open ? (
                <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
