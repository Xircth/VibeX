import { useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { cn } from '@/lib/utils';
import { AstryxMarkdown } from '../AstryxMarkdown';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import {
  applySubagentLifecycle,
  buildSubagentCardModel,
  formatTokenCount,
  type SubagentLifecycleEvent,
  type SubagentStatus,
} from './subagentCardModel';

export function SubagentCard({
  use,
  result,
  lifecycle = [],
  parentAgentId = null,
}: {
  use: ToolUseBlock;
  result: ToolResultBlock | null;
  lifecycle?: SubagentLifecycleEvent[];
  parentAgentId?: string | null;
}) {
  const { t } = useTranslation('conversation');
  const model = applySubagentLifecycle(
    buildSubagentCardModel(use, result, parentAgentId),
    lifecycle
  );
  const [openSection, setOpenSection] = useState<'prompt' | 'result' | null>(
    null
  );
  const toggleSection = (section: 'prompt' | 'result') => {
    setOpenSection((current) => (current === section ? null : section));
  };
  const durationLabel =
    model.durationMs != null ? formatDurationLabel(model.durationMs, t) : null;
  const stats = [
    model.toolCallCount != null
      ? t('subagentCard.tools', { count: model.toolCallCount })
      : null,
    model.turnCount != null
      ? t('subagentCard.turns', { count: model.turnCount })
      : null,
    model.tokenCount != null
      ? t('subagentCard.tokens', { count: formatTokenCount(model.tokenCount) })
      : null,
  ].filter((part): part is string => Boolean(part));
  const contextLabel =
    model.contextUsagePct != null
      ? t('subagentCard.context', { pct: Math.round(model.contextUsagePct) })
      : null;

  return (
    <div
      role="group"
      aria-label={model.title}
      className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-card-foreground"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground">
          {model.agentKind ? (
            <AgentTypeIcon
              agentType={model.agentKind}
              className="h-3.5 w-3.5"
            />
          ) : (
            <Bot className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">
              {model.title}
            </span>
            {model.prompt || model.resultText || durationLabel ? null : (
              <StatusPill status={model.status} />
            )}
          </div>

          {model.prompt || model.resultText || durationLabel ? (
            <div className="mt-2">
              <div className="flex min-w-0 items-center gap-3">
                {model.prompt ? (
                  <DisclosureToggle
                    label={t('subagentCard.prompt')}
                    open={openSection === 'prompt'}
                    onToggle={() => toggleSection('prompt')}
                  />
                ) : null}
                {model.resultText ? (
                  <DisclosureToggle
                    label={t('subagentCard.result')}
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
                <StatusPill status={model.status} />
              </div>
              {openSection === 'prompt' && model.prompt ? (
                <div className="mt-1.5 text-xs text-foreground">
                  <AstryxMarkdown value={model.prompt} />
                </div>
              ) : null}
              {openSection === 'result' && model.resultText ? (
                <div className="mt-1.5 text-xs text-foreground">
                  <AstryxMarkdown value={model.resultText} />
                </div>
              ) : null}
            </div>
          ) : null}

          {stats.length > 0 || contextLabel ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {stats.length > 0 ? <p>{stats.join(' · ')}</p> : null}
              {model.contextUsagePct != null && contextLabel ? (
                <ContextUsageRing
                  pct={Math.round(model.contextUsagePct)}
                  label={contextLabel}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatDurationLabel(
  ms: number,
  t: (key: string, options: { count: number }) => string
): string {
  if (ms < 1000) {
    return t('subagentCard.durationMs', { count: Math.round(ms) });
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return t('subagentCard.durationSeconds', {
      count: seconds < 10 ? Number(seconds.toFixed(1)) : Math.round(seconds),
    });
  }
  const minutes = seconds / 60;
  return t('subagentCard.durationMinutes', {
    count: minutes < 10 ? Number(minutes.toFixed(1)) : Math.round(minutes),
  });
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

function ContextUsageRing({ pct, label }: { pct: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const ringStyle = {
    background: [
      'conic-gradient(',
      `hsl(var(--foreground)) ${clamped}%, `,
      `hsl(var(--muted)) ${clamped}% 100%)`,
    ].join(''),
  };
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1"
    >
      <span
        className="inline-flex h-4 w-4 items-center justify-center rounded-full"
        style={ringStyle}
        aria-hidden="true"
      >
        <span className="h-2.5 w-2.5 rounded-full bg-card" />
      </span>
      <span>{label}</span>
    </span>
  );
}

function StatusPill({ status }: { status: SubagentStatus }) {
  const { t } = useTranslation('conversation');
  if (status === 'running' || status === 'background') {
    return (
      <span className="conv-count-badge inline-flex shrink-0 items-center gap-1 text-primary">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        {status === 'background'
          ? t('subagentCard.background')
          : t('subagentCard.running')}
      </span>
    );
  }
  const Icon = status === 'completed' ? CheckCircle2 : XCircle;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'completed'
          ? 'bg-[hsl(var(--success)/0.14)] text-foreground'
          : 'bg-destructive/10 text-destructive'
      )}
    >
      <Icon className="h-3 w-3" />
      {status === 'completed'
        ? t('subagentCard.completed')
        : t('subagentCard.failed')}
    </span>
  );
}
