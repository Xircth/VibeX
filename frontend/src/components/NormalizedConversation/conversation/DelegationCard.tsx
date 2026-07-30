import { ArrowUpRight, GitBranch, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationDelegationView } from 'shared/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Sub-agent delegation, rendered as a live card from the real `delegation_started`
 * / `delegation_completed` events (which fold into one row). Shows which agent was
 * delegated to, the task it was given, its live status, and the outcome — with an
 * action to open the child agent's own transcript. Nothing is synthesized.
 */
export function DelegationCard({
  delegation,
  onOpenChild,
}: {
  delegation: ConversationDelegationView;
  onOpenChild?: (childConversationId: string) => void;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const status = normalizeStatus(delegation.status);
  const childId = delegation.child_conversation_id ?? null;
  const result = delegation.result ?? null;
  const errorMessage =
    result?.kind === 'err' ? result.error.message : null;
  const okPreview =
    result?.kind === 'ok' ? (result.text_preview ?? null) : null;
  const durationMs =
    result?.kind === 'ok' ? (result.duration_ms ?? null) : null;

  return (
    <div className="conv-entry-item rounded-lg border border-indigo-300/50 bg-indigo-50/70 px-3 py-2.5 text-sm dark:border-indigo-500/30 dark:bg-indigo-950/25">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 rounded-md border border-indigo-300/60 bg-indigo-100/70 p-1 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-900/40 dark:text-indigo-200">
          <GitBranch className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-indigo-900 dark:text-indigo-100">
              {delegation.agent_id
                ? t('delegationCard.delegatedTo', {
                    agent: agentLabel(delegation.agent_id),
                  })
                : t('delegationCard.subAgentDelegation')}
            </span>
            <StatusPill status={status} />
          </div>

          {delegation.task_preview ? (
            <div className="mt-1.5 whitespace-pre-wrap break-words text-indigo-900/80 dark:text-indigo-100/75">
              {delegation.task_preview}
            </div>
          ) : null}

          {okPreview ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-indigo-300/40 bg-indigo-100/40 px-2.5 py-1.5 font-mono text-xs text-indigo-950 dark:border-indigo-500/25 dark:bg-indigo-900/25 dark:text-indigo-100">
              {okPreview}
            </pre>
          ) : null}

          {errorMessage ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-red-300/45 bg-red-50/70 px-2.5 py-1.5 font-mono text-xs text-red-900 dark:border-red-500/25 dark:bg-red-950/25 dark:text-red-100">
              {errorMessage}
            </pre>
          ) : null}

          {(childId && onOpenChild) || durationMs != null ? (
            <div className="mt-2 flex items-center gap-3">
              {childId && onOpenChild ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenChild(childId)}
                >
                  <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
                  {t('delegationCard.openChildSession')}
                </Button>
              ) : null}
              {durationMs != null ? (
                <span className="text-xs text-indigo-700/70 dark:text-indigo-200/60">
                  {t('delegationCard.duration', {
                    duration: formatDuration(durationMs),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Status = 'running' | 'completed' | 'failed';

function normalizeStatus(raw: string): Status {
  if (raw === 'completed' || raw === 'failed') return raw;
  return 'running';
}

function StatusPill({ status }: { status: Status }) {
  const { t } = useTranslation(['conversation', 'common']);
  if (status === 'running') {
    return (
      <span className="conv-count-badge inline-flex shrink-0 items-center gap-1 text-indigo-700 dark:text-indigo-200">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('delegationCard.running')}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'completed'
          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
          : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
      )}
    >
      {status === 'completed'
        ? t('delegationCard.completed')
        : t('delegationCard.failed')}
    </span>
  );
}

const AGENT_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  openclaw: 'OpenClaw',
  cline: 'Cline',
  hermes: 'Hermes',
  qa_mock: 'QA Mock',
};

function agentLabel(agentType: string): string {
  return AGENT_LABELS[agentType] ?? agentType;
}

function formatDuration(ms: bigint | number): string {
  const value = typeof ms === 'bigint' ? Number(ms) : ms;
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}
