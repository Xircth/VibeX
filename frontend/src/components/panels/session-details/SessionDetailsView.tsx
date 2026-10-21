import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  FilePlus2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { Badge } from '@/components/ui/badge';
import { Loader } from '@/components/ui/loader';
import {
  planProgress,
  toConversationPlanItem,
  type PlanStatus,
} from '@/components/NormalizedConversation/conversationPlan';
import { workspaceSessionStatusTone } from '@/components/workspace-session-list/workspaceSessionListModel';
import { cn } from '@/lib/utils';
import type {
  SessionDetailsModel,
  SessionFileChange,
  SessionMessageNavItem,
} from './sessionDetailsModel';

const detailCardClass =
  'flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 shadow-none [--workspace-session-row-bg:var(--surface-card)]';

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCacheRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function UsageToken({ value }: { value: string }) {
  return (
    <Badge
      variant="outline"
      className="h-6 min-w-12 shrink-0 justify-center border-[var(--border-subtle)] bg-muted px-2 py-0 text-xs font-medium tabular-nums text-foreground shadow-none"
    >
      {value}
    </Badge>
  );
}

function CacheRateRing({ rate, label }: { rate: number; label: string }) {
  const safeRate = Math.min(1, Math.max(0, rate));
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const percent = formatCacheRate(safeRate);
  return (
    <div className="kanban-usage-summary__ring">
      <svg
        aria-label={`${label}: ${percent}`}
        className="h-full w-full -rotate-90"
        viewBox="0 0 100 100"
        role="img"
      >
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth="7"
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - safeRate)}
          className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      </svg>
      <span className="kanban-usage-summary__ring-value">{percent}</span>
    </div>
  );
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function StatusMark({ status }: { status: PlanStatus }) {
  if (status === 'completed') {
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 text-[hsl(var(--success))]"
        aria-hidden="true"
      />
    );
  }
  if (status === 'in_progress') {
    return <Clock className="h-3.5 w-3.5 text-primary" aria-hidden="true" />;
  }
  return (
    <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
  );
}

function ChangeIcon({ kind }: { kind: string }) {
  if (kind === 'added' || kind === 'created') {
    return <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  if (kind === 'deleted') {
    return <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function DetailCard({
  title,
  meta,
  action,
  children,
  testId,
  hidden,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
  hidden?: boolean;
}) {
  return (
    <section
      className={cn(detailCardClass, hidden && 'hidden')}
      data-testid={testId}
      hidden={hidden}
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {title}
        </h3>
        {meta ? (
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
            {meta}
          </span>
        ) : null}
        {action}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-foreground">{value}</dd>
    </>
  );
}

function Count({ value, sign }: { value: number | null; sign: '+' | '-' }) {
  const { t } = useTranslation('panels');
  if (value == null) return null;
  return (
    <span
      className={cn(
        'font-mono text-xs tabular-nums',
        sign === '+' ? 'text-[hsl(var(--success))]' : 'text-destructive'
      )}
    >
      {sign}
      {formatTokens(value)}
      <span className="sr-only">{t('sessionDetails.lineCount')}</span>
    </span>
  );
}

export function SessionDetailsView({
  model,
  quota,
  quotaActive = false,
  onJumpToMessage,
  onOpenFile,
}: {
  model: SessionDetailsModel;
  quota?: ReactNode;
  quotaActive?: boolean;
  onJumpToMessage: (turnId: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useTranslation(['panels', 'conversation']);
  const [usageMode, setUsageMode] = useState<'model' | 'message'>('model');
  const [messagesOpen, setMessagesOpen] = useState(true);
  const activeMessageId = model.kind === 'ready' ? model.activeMessageId : null;
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(
    activeMessageId
  );
  useEffect(() => {
    setExpandedMessageId(activeMessageId);
  }, [activeMessageId]);
  const missing = t('sessionDetails.missing');

  if (model.kind === 'empty') {
    return (
      <div
        className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground"
        data-panel="session-details"
      >
        {t('sessionDetails.empty')}
      </div>
    );
  }

  if (model.kind === 'loading') {
    return (
      <div
        className="flex h-full items-center justify-center bg-background"
        data-panel="session-details"
      >
        <Loader size={24} />
        <span className="sr-only">{t('sessionDetails.loading')}</span>
      </div>
    );
  }

  if (model.kind === 'error') {
    return (
      <div
        className="flex h-full items-center justify-center bg-background p-6 text-sm text-destructive"
        data-panel="session-details"
      >
        {model.message || t('sessionDetails.loadFailed')}
      </div>
    );
  }

  const planItems = model.plan.map(toConversationPlanItem);
  const progress = planProgress(planItems);
  const agentName = model.agentId ? getAgentName(model.agentId) : null;
  const statusLabel = model.status
    ? t(`conversation:children.status.${model.status}`)
    : null;
  const statusTone = model.status
    ? workspaceSessionStatusTone({
        status: model.status,
        isRunning: model.status === 'inprogress',
      })
    : null;
  const reportedUsage = hasReportedUsage(model.usage);
  const hasDistribution = hasUsageDistribution(model.usage);
  const showUsage = reportedUsage || hasDistribution;

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-background p-3 text-foreground"
      data-panel="session-details"
    >
      <section className={cn(detailCardClass, 'gap-3')}>
        <p className="text-base font-semibold leading-snug">
          {model.title || t('sessionDetails.untitled')}
        </p>
        {agentName || statusLabel ? (
          <p className="flex items-center gap-2 text-sm">
            <span className="workspace-session-icon" aria-hidden="true">
              {model.agentId ? (
                <AgentIcon agent={model.agentId} className="h-4 w-4" />
              ) : (
                <Bot className="h-4 w-4 text-muted-foreground" />
              )}
              {statusTone ? (
                <span
                  className={cn(
                    'workspace-session-status z-[1]',
                    `workspace-session-status--${statusTone}`
                  )}
                />
              ) : null}
            </span>
            {agentName ? <span>{agentName}</span> : null}
            {statusLabel ? (
              <span className="text-muted-foreground">{statusLabel}</span>
            ) : null}
          </p>
        ) : null}
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <Fact label={t('sessionDetails.model')} value={model.model} />
          <Fact label={t('sessionDetails.branch')} value={model.branch} />
          <Fact label={t('sessionDetails.sessionId')} value={model.sessionId} />
        </dl>
      </section>

      {planItems.length > 0 ? (
        <DetailCard
          title={t('sessionDetails.plan')}
          meta={t('sessionDetails.planProgress', {
            completed: progress.completed,
            total: progress.total,
          })}
        >
          <div className="flex flex-col gap-2">
            <div
              className="flex h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.completed}
              aria-label={t('sessionDetails.plan')}
            >
              <div
                className="h-full bg-[hsl(var(--success))]"
                style={{
                  width: `${(progress.completed / progress.total) * 100}%`,
                }}
              />
              <div
                className="h-full bg-primary"
                style={{
                  width: `${(progress.inProgress / progress.total) * 100}%`,
                }}
              />
            </div>
            <ol className="flex flex-col gap-1.5">
              {planItems.map((item, index) => (
                <li key={`${index}-${item.content}`} className="min-w-0">
                  <div className="flex items-start gap-2 text-sm">
                    <StatusMark status={item.status} />
                    <span className="min-w-0 flex-1">{item.content}</span>
                  </div>
                  {item.children.length > 0 ? (
                    <ul className="ml-6 mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {item.children.map((child) => (
                        <li key={child}>{child}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </DetailCard>
      ) : null}

      {model.messages.length > 0 ? (
        <section className={detailCardClass}>
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            aria-expanded={messagesOpen}
            onClick={() => setMessagesOpen((open) => !open)}
          >
            <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {t('sessionDetails.messages')}
            </h3>
            <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {model.messages.length}
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                !messagesOpen && '-rotate-90'
              )}
              aria-hidden="true"
            />
          </button>
          {messagesOpen ? (
            <nav
              aria-label={t('sessionDetails.messages')}
              className="max-h-48 overflow-y-auto"
              data-testid="session-message-nav"
            >
              <ol className="flex flex-col">
                {model.messages.map((message) => (
                  <MessageNavRow
                    key={message.turnId}
                    message={message}
                    expanded={expandedMessageId === message.turnId}
                    onOpen={onOpenFile}
                    onSelect={() => {
                      setExpandedMessageId(message.turnId);
                      onJumpToMessage(message.turnId);
                    }}
                  />
                ))}
              </ol>
            </nav>
          ) : null}
        </section>
      ) : null}

      {showUsage ? (
        <DetailCard
          title={t('sessionDetails.usage')}
          testId="session-usage-card"
          action={
            hasDistribution ? (
              <div className="ml-auto shrink-0 text-xs [&_.astryx-segmented-control-item]:text-xs">
                <SegmentedControl
                  value={usageMode}
                  onChange={(value) =>
                    setUsageMode(value === 'message' ? 'message' : 'model')
                  }
                  label={t('sessionDetails.distribution')}
                  size="sm"
                  layout="hug"
                >
                  <SegmentedControlItem
                    value="model"
                    label={t('sessionDetails.byModel')}
                  />
                  <SegmentedControlItem
                    value="message"
                    label={t('sessionDetails.byMessage')}
                  />
                </SegmentedControl>
              </div>
            ) : null
          }
        >
          {reportedUsage ? (
            <div className="flex min-w-0 items-center justify-between gap-3">
              {model.usage.totalTokens != null ? (
                <div className="min-w-0" data-testid="session-total-tokens">
                  <strong
                    className="kanban-usage-stat__value block truncate font-semibold tabular-nums text-foreground"
                    title={formatTokens(model.usage.totalTokens)}
                  >
                    {formatTokens(model.usage.totalTokens)}
                  </strong>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('sessionDetails.totalTokens')}
                  </div>
                </div>
              ) : (
                <span />
              )}
              {model.usage.cacheRate != null ? (
                <div
                  className="flex shrink-0 flex-col items-center gap-1"
                  data-testid="session-cache-rate"
                >
                  <div className="kanban-usage-summary__cache">
                    <CacheRateRing
                      rate={model.usage.cacheRate}
                      label={t('sessionDetails.cacheRate')}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('sessionDetails.cacheRate')}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {model.usage.truncated && model.usage.itemized ? (
            <p className="text-xs text-muted-foreground">
              {t('sessionDetails.loadedOnly')}
            </p>
          ) : null}
          {hasDistribution ? (
            <UsageList mode={usageMode} model={model} missing={missing} />
          ) : null}
        </DetailCard>
      ) : null}

      {quota ? (
        // The quota child is what discovers a signed-in subscription. It has
        // to stay mounted; hiding the card until then would leave it unmounted.
        <DetailCard
          title={t('sessionDetails.quota')}
          hidden={!quotaActive}
          testId="session-quota-card"
        >
          {quota}
        </DetailCard>
      ) : null}
    </div>
  );
}

function hasReportedUsage(
  usage: Extract<SessionDetailsModel, { kind: 'ready' }>['usage']
): boolean {
  return usage.totalTokens != null || usage.cacheRate != null;
}

function hasUsageDistribution(
  usage: Extract<SessionDetailsModel, { kind: 'ready' }>['usage']
): boolean {
  return (
    usage.byModel.length > 0 ||
    usage.byMessage.some((message) => message.tokens != null)
  );
}

function MessageNavRow({
  message,
  expanded,
  onSelect,
  onOpen,
}: {
  message: SessionMessageNavItem;
  expanded: boolean;
  onSelect: () => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation('panels');
  const preview =
    message.preview ||
    t('sessionDetails.messageFallback', { ordinal: message.ordinal });
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-[var(--radius)] px-1 py-1.5 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          expanded && 'bg-muted/60'
        )}
        onClick={onSelect}
        aria-expanded={message.changes.files.length > 0 ? expanded : undefined}
        aria-label={t('sessionDetails.jumpToMessage', {
          ordinal: message.ordinal,
        })}
      >
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1 text-xs tabular-nums leading-none text-muted-foreground">
          {message.ordinal}
        </span>
        <span className="flex h-5 min-w-0 flex-1 items-center truncate leading-none">
          {preview}
        </span>
      </button>
      {expanded && message.changes.files.length > 0 ? (
        <div className="mb-1 ml-7">
          <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span>
              {t('sessionDetails.filesChanged', {
                count: message.changes.files.length,
              })}
            </span>
            <Count value={message.changes.additions} sign="+" />
            <Count value={message.changes.deletions} sign="-" />
          </p>
          <ul className="flex flex-col">
            {message.changes.files.map((file) => (
              <FileRow key={file.path} file={file} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

function FileRow({
  file,
  onOpen,
}: {
  file: SessionFileChange;
  onOpen: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-[var(--radius)] px-1 py-1.5 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={file.path}
        onClick={() => onOpen(file.path)}
      >
        <ChangeIcon kind={file.changeKind} />
        <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
        <Count value={file.additions} sign="+" />
        <Count value={file.deletions} sign="-" />
      </button>
    </li>
  );
}

function UsageList({
  mode,
  model,
  missing,
}: {
  mode: 'model' | 'message';
  model: Extract<SessionDetailsModel, { kind: 'ready' }>;
  missing: string;
}) {
  const { t } = useTranslation('panels');
  if (mode === 'model') {
    if (model.usage.byModel.length === 0) {
      return (
        <p className="mt-3 text-sm text-muted-foreground">
          {t('sessionDetails.usageEmpty')}
        </p>
      );
    }
    return (
      <UsageDistribution testId="session-usage-list">
        {model.usage.byModel.map((group) => (
          <li
            key={group.key || 'unlabeled'}
            className="flex items-center justify-between gap-3 px-2 py-1 text-sm"
          >
            <span className="min-w-0 truncate">
              {group.label ?? t('sessionDetails.unlabeledModel')}
            </span>
            <UsageToken value={formatTokens(group.tokens)} />
          </li>
        ))}
      </UsageDistribution>
    );
  }

  if (model.usage.byMessage.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        {t('sessionDetails.usageEmpty')}
      </p>
    );
  }

  return (
    <UsageDistribution testId="session-usage-list" scroll>
      {model.usage.byMessage.map((message) => (
        <li
          key={message.turnId}
          className="flex items-center justify-between gap-3 px-2 py-1 text-sm"
        >
          <span className="min-w-0 truncate">
            {message.ordinal}.{' '}
            {message.preview ||
              t('sessionDetails.messageFallback', { ordinal: message.ordinal })}
          </span>
          <UsageToken
            value={
              message.tokens == null ? missing : formatTokens(message.tokens)
            }
          />
        </li>
      ))}
    </UsageDistribution>
  );
}

function UsageDistribution({
  children,
  scroll = false,
  testId,
}: {
  children: ReactNode;
  scroll?: boolean;
  testId: string;
}) {
  return (
    <div
      className={cn(
        'mt-3 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-background p-1',
        scroll && 'max-h-48 overflow-y-auto'
      )}
      data-testid={testId}
    >
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}
