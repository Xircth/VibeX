import {
  ArrowUpRight,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
    ? agentDisplayLabel(agentId)
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

  const well =
    openSection === 'task' && delegation.task_preview
      ? { text: delegation.task_preview, tone: 'default' as const }
      : openSection === 'result' && resultText
        ? {
            text: resultText,
            tone:
              status === 'failed' ? ('danger' as const) : ('default' as const),
          }
        : null;

  return (
    <div
      role="group"
      aria-label={cardLabel}
      data-testid="host-delegation-card"
      className="host-delegation-card rounded-lg border border-border/50 bg-[var(--surface-control)] text-sm text-card-foreground"
    >
      <div data-testid="host-delegation-body" className="px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            data-testid="host-delegation-agent-icon"
            className="inline-flex h-5 w-5 shrink-0 self-center items-center justify-center text-muted-foreground"
          >
            {agentId ? (
              <AgentTypeIcon agentType={agentId} className="h-5 w-5" />
            ) : (
              <Bot className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span
                data-testid="host-delegation-agent-name"
                className="host-delegation-wide-only min-w-0 truncate font-medium text-foreground"
              >
                {cardLabel}
              </span>
              <StatusPill status={status} />
              {childId && onOpenChild ? (
                <button
                  type="button"
                  className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => onOpenChild(childId)}
                >
                  <ArrowUpRight className="h-3 w-3" />
                  {t('delegationCard.openChildSession')}
                </button>
              ) : null}
            </div>
            {delegation.task_preview ||
            resultText ||
            durationLabel ||
            canCancel ? (
              <div className="mt-2 flex min-w-0 items-center gap-2 overflow-hidden">
                {delegation.task_preview ? (
                  <DelegationDisclosureButton
                    label={t('delegationCard.task')}
                    open={openSection === 'task'}
                    onToggle={() => toggleSection('task')}
                  />
                ) : null}
                {resultText ? (
                  <DelegationDisclosureButton
                    label={t('delegationCard.result')}
                    open={openSection === 'result'}
                    onToggle={() => toggleSection('result')}
                  />
                ) : null}
                {canCancel ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className={cn(!durationLabel && 'ml-auto')}
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
                {durationLabel ? (
                  <span
                    data-testid="host-delegation-duration"
                    className="host-delegation-wide-only ml-auto shrink-0 text-xs text-muted-foreground"
                  >
                    {durationLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {well ? (
          <DelegationDisclosurePanel tone={well.tone}>
            <AstryxMarkdown value={well.text} />
          </DelegationDisclosurePanel>
        ) : null}
        {cancelError ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t('delegationCard.cancelFailed', { error: cancelError })}
          </p>
        ) : null}
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

function DelegationDisclosureButton({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="secondary"
      aria-expanded={open}
      className={cn(
        'h-6 gap-1 px-2 text-xs font-medium',
        open && 'bg-[var(--surface-control-hover)] text-foreground'
      )}
      onClick={onToggle}
    >
      <ChevronRight
        aria-hidden
        className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
      />
      {label}
    </Button>
  );
}

function DelegationDisclosurePanel({
  tone,
  children,
}: {
  tone: 'default' | 'danger';
  children: ReactNode;
}) {
  return (
    <div
      data-testid="host-delegation-well"
      className={cn(
        'mt-3 max-h-[min(24rem,50vh)] overflow-y-auto rounded-md bg-background/80 px-3 py-2.5 text-xs break-words',
        tone === 'danger' ? 'text-destructive' : 'text-foreground'
      )}
    >
      {children}
    </div>
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

export function agentDisplayLabel(agentType: string): string {
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
