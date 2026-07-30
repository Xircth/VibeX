import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  GitBranch,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationDelegationView } from 'shared/types';
import { Button } from '@/components/ui/button';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
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
  const transport = useBackendTransport();
  const { supports } = useBackendCapabilities();
  const [isCanceling, setIsCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const status = normalizeStatus(delegation.status);
  const childId = delegation.child_conversation_id ?? null;
  const result = delegation.result ?? null;
  const errorMessage = result?.kind === 'err' ? result.error.message : null;
  const okPreview =
    result?.kind === 'ok' ? (result.text_preview ?? null) : null;
  const durationMs =
    result?.kind === 'ok' ? (result.duration_ms ?? null) : null;
  const cardLabel = delegation.agent_id
    ? t('delegationCard.delegatedTo', {
        agent: agentLabel(delegation.agent_id),
      })
    : t('delegationCard.subAgentDelegation');
  const canCancel =
    status === 'running' && childId !== null && supports('delegation.cancel');

  const cancel = async () => {
    if (!childId || isCanceling) return;
    setIsCanceling(true);
    setCancelError(null);
    try {
      await transport.call('delegation_cancel', {
        childConversationId: childId,
      });
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCanceling(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={cardLabel}
      className="conv-entry-item rounded-[10px] border border-border bg-card px-3 py-2.5 text-sm text-card-foreground"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 rounded-md border border-border bg-muted p-1 text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{cardLabel}</span>
            <StatusPill status={status} />
          </div>

          {delegation.task_preview ? (
            <div className="mt-1.5 whitespace-pre-wrap break-words text-foreground">
              {delegation.task_preview}
            </div>
          ) : null}

          {okPreview ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-xs text-foreground">
              {okPreview}
            </pre>
          ) : null}

          {errorMessage ? (
            <pre
              className={cn(
                'mt-2 overflow-x-auto whitespace-pre-wrap rounded-md px-2.5 py-1.5 font-mono text-xs',
                status === 'canceled'
                  ? 'bg-muted/60 text-foreground'
                  : 'bg-destructive/10 text-destructive'
              )}
            >
              {errorMessage}
            </pre>
          ) : null}

          {(childId && onOpenChild) || canCancel || durationMs != null ? (
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
              {canCancel ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isCanceling}
                  onClick={() => void cancel()}
                >
                  {isCanceling ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Ban className="mr-1 h-3.5 w-3.5" />
                  )}
                  {isCanceling
                    ? t('delegationCard.canceling')
                    : t('delegationCard.cancel')}
                </Button>
              ) : null}
              {durationMs != null ? (
                <span className="text-xs text-foreground">
                  {t('delegationCard.duration', {
                    duration: formatDuration(durationMs),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          {cancelError ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {t('delegationCard.cancelFailed', { error: cancelError })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Status = 'running' | 'completed' | 'failed' | 'canceled';

function normalizeStatus(raw: string): Status {
  if (raw === 'completed' || raw === 'failed' || raw === 'canceled') {
    return raw;
  }
  if (raw === 'cancelled') return 'canceled';
  return 'running';
}

function StatusPill({ status }: { status: Status }) {
  const { t } = useTranslation(['conversation', 'common']);
  if (status === 'running') {
    return (
      <span className="conv-count-badge inline-flex shrink-0 items-center gap-1 text-primary">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        {t('delegationCard.running')}
      </span>
    );
  }
  const Icon =
    status === 'completed' ? CheckCircle2 : status === 'failed' ? XCircle : Ban;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'completed'
          ? 'bg-[hsl(var(--success)/0.14)] text-foreground'
          : status === 'failed'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-muted text-foreground'
      )}
    >
      <Icon className="h-3 w-3" />
      {status === 'completed'
        ? t('delegationCard.completed')
        : status === 'failed'
          ? t('delegationCard.failed')
          : t('delegationCard.canceled')}
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
