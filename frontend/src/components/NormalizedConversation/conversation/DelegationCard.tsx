import {
  ArrowUpRight,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationDelegationView } from 'shared/types';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { Button } from '@/components/ui/button';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import { AstryxMarkdown } from '../AstryxMarkdown';

/**
 * Host-mediated MCP delegation. One product card per `delegate_to_agent` call,
 * fed by the tool use plus the folded `delegation_started` /
 * `delegation_completed` row. Opening the child stays in the parent session
 * overlay. Native vendor subagents stay on SubagentCard.
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
  const [openSection, setOpenSection] = useState<'task' | 'result' | null>(
    null
  );
  const status = normalizeStatus(delegation.status);
  const childId = delegation.child_conversation_id ?? null;
  const result = delegation.result ?? null;
  const errorMessage = result?.kind === 'err' ? result.error.message : null;
  const okPreview =
    result?.kind === 'ok' ? (result.text_preview ?? null) : null;
  const resultText = okPreview ?? errorMessage;
  const durationMs =
    result?.kind === 'ok' ? toDurationMs(result.duration_ms) : null;
  const durationLabel =
    durationMs != null ? formatDurationLabel(durationMs, t) : null;
  const agentId = delegation.agent_id ?? null;
  const cardLabel = agentId
    ? t('delegationCard.delegatedTo', { agent: agentLabel(agentId) })
    : t('delegationCard.subAgentDelegation');
  const canCancel =
    status === 'running' && childId !== null && supports('delegation.cancel');
  const toggleSection = (section: 'task' | 'result') => {
    setOpenSection((current) => (current === section ? null : section));
  };

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
      data-testid="host-delegation-card"
      className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-card-foreground"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground">
          {agentId ? (
            <AgentTypeIcon agentType={agentId} className="h-3.5 w-3.5" />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">
              {cardLabel}
            </span>
            {delegation.task_preview || resultText || durationLabel ? null : (
              <StatusPill status={status} />
            )}
          </div>

          {delegation.task_preview || resultText || durationLabel ? (
            <div className="mt-2">
              <div className="flex min-w-0 items-center gap-3">
                {delegation.task_preview ? (
                  <DisclosureToggle
                    label={t('delegationCard.task')}
                    open={openSection === 'task'}
                    onToggle={() => toggleSection('task')}
                  />
                ) : null}
                {resultText ? (
                  <DisclosureToggle
                    label={t('delegationCard.result')}
                    open={openSection === 'result'}
                    onToggle={() => toggleSection('result')}
                  />
                ) : null}
                <span className="flex min-w-0 flex-1 items-center justify-center">
                  {durationLabel ? (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {durationLabel}
                    </span>
                  ) : null}
                </span>
                <StatusPill status={status} />
              </div>
              {openSection === 'task' && delegation.task_preview ? (
                <div className="mt-1.5 text-xs text-foreground">
                  <AstryxMarkdown value={delegation.task_preview} />
                </div>
              ) : null}
              {openSection === 'result' && resultText ? (
                <div
                  className={cn(
                    'mt-1.5 text-xs',
                    status === 'failed' ? 'text-destructive' : 'text-foreground'
                  )}
                >
                  <AstryxMarkdown value={resultText} />
                </div>
              ) : null}
            </div>
          ) : null}

          {(childId && onOpenChild) || canCancel ? (
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

function DisclosureToggle({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronRight
        aria-hidden
        className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
      />
      {label}
    </button>
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
  codebuddy: 'CodeBuddy',
  kimi_code: 'Kimi Code',
  pi: 'Pi',
  grok: 'Grok',
  cursor: 'Cursor',
  deepseek_harness: 'DeepSeek Harness',
  qa_mock: 'QA Mock',
};

function agentLabel(agentType: string): string {
  return AGENT_LABELS[agentType] ?? agentType;
}

function toDurationMs(
  value: bigint | number | null | undefined
): number | null {
  if (value == null) return null;
  const next = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(next) ? next : null;
}

function formatDurationLabel(
  ms: number,
  t: (key: string, options: { count: number }) => string
): string {
  if (ms < 1000) {
    return t('delegationCard.durationMs', { count: Math.round(ms) });
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return t('delegationCard.durationSeconds', {
      count: seconds < 10 ? Number(seconds.toFixed(1)) : Math.round(seconds),
    });
  }
  const minutes = seconds / 60;
  return t('delegationCard.durationMinutes', {
    count: minutes < 10 ? Number(minutes.toFixed(1)) : Math.round(minutes),
  });
}
