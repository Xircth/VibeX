import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Bot, Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationRelationView } from 'shared/types';

import { Button } from '@/components/ui/button';
import { conversationApi } from '@/features/conversation/conversationApi';
import { cn } from '@/lib/utils';

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

function statusTone(status: string) {
  if (status === 'done') return 'text-emerald-700 dark:text-emerald-400';
  if (status === 'inprogress') return 'text-blue-700 dark:text-blue-400';
  if (status === 'inreview') return 'text-amber-700 dark:text-amber-400';
  return 'text-muted-foreground';
}

export function ConversationChildrenSummary({
  conversationId,
  onOpenChild,
}: {
  conversationId: string;
  onOpenChild?: (conversationId: string, workspaceId: string) => void;
}) {
  const { t } = useTranslation('conversation');
  const [relations, setRelations] = useState<ConversationRelationView[]>([]);

  useEffect(() => {
    let active = true;
    const load = () =>
      conversationApi
        .listRelations(conversationId)
        .then((next) => {
          if (active) setRelations(next);
        })
        .catch(() => undefined);
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [conversationId]);

  const { children, activeCount, waitingCount, budget } = useMemo(
    () => summarizeConversationChildren(relations),
    [relations]
  );
  if (children.length === 0) return null;

  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-border/70 bg-card/60">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Bot className="size-3.5 text-muted-foreground" />
          {t('children.title', { count: children.length })}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px]">
          {budget ? (
            <span className="text-muted-foreground">
              {t('children.budget', {
                callsUsed: budget.callsUsed,
                maxCalls: budget.maxCalls,
                active: budget.activeChildren,
                maxActive: budget.maxActiveChildren,
              })}
            </span>
          ) : null}
          {waitingCount > 0 ? (
            <span className="text-amber-700 dark:text-amber-400">
              {t('children.waiting', { count: waitingCount })}
            </span>
          ) : null}
          {activeCount > 0 ? (
            <span className="flex items-center gap-1 text-blue-700 dark:text-blue-400">
              <Clock3 className="size-3" />
              {t('children.active', { count: activeCount })}
            </span>
          ) : null}
        </div>
      </header>
      <div className="divide-y divide-border/60">
        {children.map((relation) => (
          <div
            key={relation.id}
            className="flex min-w-0 items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">
                {relation.child.title || t('children.untitled')}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                <span className={cn(statusTone(relation.child.status))}>
                  {t(`children.status.${relation.child.status}`)}
                </span>
                {relation.child.queuedInputCount > 0n ? (
                  <span>
                    {t('children.queued', {
                      count: String(relation.child.queuedInputCount),
                    })}
                  </span>
                ) : null}
                <span>{relation.kind}</span>
              </div>
            </div>
            {onOpenChild ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('children.open')}
                onClick={() =>
                  onOpenChild(
                    relation.childConversationId,
                    relation.child.workspaceId
                  )
                }
              >
                <ArrowUpRight className="size-3.5" />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
