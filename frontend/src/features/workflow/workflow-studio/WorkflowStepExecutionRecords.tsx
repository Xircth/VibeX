import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bell,
  Check,
  Clock,
  GitFork,
  Loader2,
  Repeat,
  Send,
  ShieldCheck,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { WorkflowEventRecord } from 'shared/types';

import {
  AstryxSelect,
  type AstryxSelectOption,
} from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';
import type { PulseOutboxEntryView } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import { WorkflowStepConversation } from '../WorkflowStepConversation';
import type { StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import {
  describeStepPresentation,
  formatWorkflowEventSource,
  formatWorkflowTemporalBadge,
  statusDotClass,
} from './workflowStepPresentation';

function formatShortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function tryFormatJson(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function tryParseObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function MetricPill({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-element)] bg-muted/45 px-2.5 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 truncate text-xs font-medium text-foreground',
          mono && 'font-mono text-[11px] tabular-nums'
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function PayloadBlock({
  label,
  value,
  defaultOpen = false,
  testId,
}: {
  label: string;
  value: string | null | undefined;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const formatted = tryFormatJson(value);
  if (!formatted) return null;
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      className="rounded-[var(--radius-element)] bg-muted/35 px-2.5 py-1.5"
    >
      <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <pre className="mt-1.5 max-h-40 overflow-auto rounded-[var(--radius-inner)] bg-background/70 p-2 font-mono text-[11px] leading-4 text-foreground">
        {formatted}
      </pre>
    </details>
  );
}

function DurableEventList({
  events,
  title,
  emptyLabel,
}: {
  events: readonly WorkflowEventRecord[];
  title: string;
  emptyLabel: string;
}) {
  return (
    <div
      data-testid="step-records-events"
      className="space-y-1.5 rounded-[var(--radius-element)] bg-muted/35 p-2.5"
    >
      <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>{title}</span>
        <span className="font-mono tabular-nums">{events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/80">{emptyLabel}</p>
      ) : (
        <ol className="max-h-36 space-y-1 overflow-auto font-mono text-[11px] tabular-nums">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-inner)] bg-background/60 px-2 py-1"
            >
              <span className="min-w-0 truncate text-foreground">
                <span className="mr-1.5 text-muted-foreground">
                  #{event.sequence.toString()}
                </span>
                {event.eventKind}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatShortTime(event.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function WorkflowStepExecutionRecords({
  selectedStep,
  studio,
}: {
  selectedStep: StudioWorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    run,
    runs,
    selectedRunId,
    onSelectRunId,
    recordsLoading,
    selectedRun,
    selectedStepRuns,
    selectedStepEvents,
    events,
    capturedEvents,
    outboxEntries,
    unsavedStepIds,
    activeWorktree,
    agentOptions,
    bots,
    spaces,
    outputLanguage,
    onTestNode,
    onPauseStep,
    onSubmitStepInput,
    onAcceptCandidate,
    onDecideApproval,
  } = studio;

  const sortedAttempts = useMemo(
    () =>
      [...selectedStepRuns].sort((left, right) =>
        left.attempt > right.attempt ? -1 : left.attempt < right.attempt ? 1 : 0
      ),
    [selectedStepRuns]
  );

  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    null
  );
  useEffect(() => {
    setSelectedAttemptId(sortedAttempts[0]?.id ?? null);
  }, [selectedStep.id, run?.id, sortedAttempts]);

  const activeAttempt =
    sortedAttempts.find((item) => item.id === selectedAttemptId) ??
    sortedAttempts[0] ??
    selectedRun;

  const presentation = describeStepPresentation(
    selectedStep,
    agentOptions,
    t('studio.notify'),
    t,
    {
      bots,
      spaces,
      language: outputLanguage,
    }
  );

  const sessionOrAgentStep =
    selectedStep.kind === 'session' || selectedStep.kind === 'agent'
      ? selectedStep
      : null;

  const runSelectOptions = useMemo<AstryxSelectOption[]>(
    () =>
      runs.map((item) => ({
        value: item.id,
        label: t('inspector.records.runOption', {
          status: t(`status.${item.status}`, { defaultValue: item.status }),
          time: formatShortTime(item.createdAt),
        }),
      })),
    [runs, t]
  );

  const attemptSelectOptions = useMemo<AstryxSelectOption[]>(
    () =>
      sortedAttempts.map((item) => ({
        value: item.id,
        label: t('inspector.records.attemptLabel', {
          attempt: item.attempt.toString(),
        }),
      })),
    [sortedAttempts, t]
  );

  const correlatedEvents = useMemo(() => {
    if (selectedStepEvents.length > 0) return selectedStepEvents;
    if (selectedStep.kind === 'trigger') {
      return events.filter((item) =>
        item.eventKind.toLowerCase().includes('run')
      );
    }
    return selectedStepEvents;
  }, [events, selectedStep.kind, selectedStepEvents]);

  const effectiveStatus = activeAttempt?.awaitingAcceptance
    ? 'awaiting_acceptance'
    : activeAttempt?.awaitingInput
      ? 'awaiting_input'
      : activeAttempt?.status;
  const statusLabel = effectiveStatus
    ? t(`status.${effectiveStatus}`, { defaultValue: effectiveStatus })
    : t('studio.standby');

  const runSwitcherBar =
    runs.length > 0 || sortedAttempts.length > 1 || recordsLoading ? (
      <div
        data-testid="workflow-records-run-bar"
        className="flex shrink-0 flex-wrap items-center gap-1.5"
      >
        {runs.length > 0 && onSelectRunId ? (
          <AstryxSelect
            data-testid="records-run-selector"
            ariaLabel={t('inspector.records.runPickerAria')}
            value={selectedRunId ?? run?.id ?? runs[0]!.id}
            options={runSelectOptions}
            onChange={onSelectRunId}
            size="compact"
            className="min-w-0 flex-1"
          />
        ) : null}
        {sortedAttempts.length > 1 && activeAttempt ? (
          <AstryxSelect
            data-testid="records-attempt-selector"
            ariaLabel={t('inspector.records.attemptLabel', {
              attempt: activeAttempt.attempt.toString(),
            })}
            value={activeAttempt.id}
            options={attemptSelectOptions}
            onChange={setSelectedAttemptId}
            size="compact"
            className="w-[120px] shrink-0"
          />
        ) : null}
        {recordsLoading ? (
          <Loader2
            aria-label={t('inspector.records.loadingRecords')}
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
        ) : null}
      </div>
    ) : null;

  if (sessionOrAgentStep) {
    return (
      <div
        data-testid="workflow-step-records"
        data-record-kind={presentation.category}
        className="flex h-full min-h-0 flex-col gap-2"
      >
        {runSwitcherBar}
        <div className="min-h-0 flex-1">
          <WorkflowStepConversation
            stepRun={activeAttempt}
            saved={!unsavedStepIds.has(selectedStep.id)}
            workspacePath={activeWorktree?.path}
            isTestable
            onTestNode={
              onTestNode ? () => onTestNode(selectedStep.id) : undefined
            }
            onPause={() => onPauseStep?.(selectedStep.id)}
            onSubmit={(text) => onSubmitStepInput?.(selectedStep.id, text)}
            onConfirm={
              activeAttempt?.awaitingAcceptance
                ? () => onAcceptCandidate?.(selectedStep.id)
                : undefined
            }
          />
        </div>
      </div>
    );
  }

  const renderCategoryBody = () => {
    switch (selectedStep.kind) {
      case 'trigger': {
        const matchingCaptured = (capturedEvents ?? []).filter((envelope) => {
          if (selectedStep.triggerKind === 'temporal') return false;
          if (
            selectedStep.sourceKind &&
            envelope.source.kind !== selectedStep.sourceKind
          ) {
            return false;
          }
          if (
            selectedStep.eventType &&
            envelope.eventType !== selectedStep.eventType
          ) {
            return false;
          }
          return true;
        });

        const scheduleOrEvent =
          selectedStep.triggerKind === 'temporal' && selectedStep.temporal
            ? formatWorkflowTemporalBadge(selectedStep.temporal, t)
            : `${formatWorkflowEventSource(selectedStep.sourceKind, t)} · ${selectedStep.eventType}`;

        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <MetricPill
                label={
                  selectedStep.triggerKind === 'temporal'
                    ? t('inspector.records.trigger.scheduleLabel')
                    : t('inspector.records.trigger.sourceLabel')
                }
                value={
                  selectedStep.triggerKind === 'temporal'
                    ? scheduleOrEvent
                    : formatWorkflowEventSource(selectedStep.sourceKind, t)
                }
              />
              <MetricPill
                label={t('inspector.records.trigger.gateLabel')}
                value={
                  run
                    ? t('inspector.records.trigger.matched')
                    : t('studio.standby')
                }
              />
            </div>
            {run ? (
              <PayloadBlock
                testId="trigger-record-run-input"
                label={t('inspector.records.trigger.payloadLabel')}
                value={run.inputJson}
                defaultOpen
              />
            ) : null}
            <div className="space-y-1.5 rounded-[var(--radius-element)] bg-muted/35 p-2.5">
              <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Zap className="size-3 text-info" />
                  {t('inspector.records.trigger.capturedTitle')}
                </span>
                <span className="font-mono tabular-nums">
                  {matchingCaptured.length}
                </span>
              </div>
              {matchingCaptured.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/80">
                  {t('inspector.records.noRunsYet')}
                </p>
              ) : (
                <ul className="max-h-36 space-y-1 overflow-auto">
                  {matchingCaptured.slice(0, 6).map((evt) => (
                    <li
                      key={evt.eventId}
                      className="flex items-center justify-between gap-2 rounded-[var(--radius-inner)] bg-background/60 px-2 py-1 text-[11px]"
                    >
                      <span className="min-w-0 truncate font-mono text-foreground">
                        {evt.eventType}
                        {evt.threadKey ? ` · ${evt.threadKey}` : ''}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                        {formatShortTime(evt.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      }

      case 'bot': {
        return (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 rounded-[var(--radius-element)] bg-muted/45 px-2.5 py-2">
              {presentation.botAvatar ? (
                <MemberBotAvatar
                  config={presentation.botAvatar}
                  animated={false}
                  className="size-5 shrink-0"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {presentation.identityBadge}
                </div>
                <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                  {selectedStep.memberId}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <MetricPill
                label={t('inspector.records.bot.scopeLabel')}
                value={t(`inspector.bot.scopes.${selectedStep.conversationScope}`)}
              />
              <MetricPill
                label={t('inspector.records.bot.mailboxLabel')}
                value={t(`inspector.bot.mailboxOptions.${selectedStep.mailboxPolicy}`)}
              />
            </div>
            {activeAttempt?.conversationId ? (
              <MetricPill
                label={t('inspector.records.bot.conversationLabel')}
                value={
                  activeAttempt.turnId
                    ? `${activeAttempt.conversationId} · ${activeAttempt.turnId}`
                    : activeAttempt.conversationId
                }
                mono
              />
            ) : null}
            <PayloadBlock
              testId="bot-record-input"
              label={t('inspector.records.bot.inputLabel')}
              value={activeAttempt?.resolvedInputJson}
            />
            <PayloadBlock
              testId="bot-record-output"
              label={t('inspector.records.bot.outputLabel')}
              value={
                activeAttempt?.outputJson ?? activeAttempt?.candidateOutputJson
              }
              defaultOpen
            />
            <PayloadBlock
              label={t('inspector.records.bot.evidenceLabel')}
              value={activeAttempt?.executionEvidenceJson}
            />
          </div>
        );
      }

      case 'group_stage': {
        const dispatchSummary =
          selectedStep.dispatchMode.type === 'specific_seat'
            ? t('nodes.groupDispatch.specific_seat', {
                memberId: selectedStep.dispatchMode.memberId,
              })
            : selectedStep.dispatchMode.type === 'mention_seats'
              ? t('nodes.groupDispatch.mention_seats', {
                  count: selectedStep.dispatchMode.memberIds.length,
                })
              : selectedStep.dispatchMode.type === 'moderator_triage'
                ? t('nodes.groupDispatch.moderator_triage', {
                    memberId: selectedStep.dispatchMode.moderatorMemberId,
                  })
                : t('nodes.groupDispatch.broadcast_log_only');

        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <MetricPill
                label={t('inspector.records.group.spaceLabel')}
                value={presentation.identityBadge}
              />
              <MetricPill
                label={t('inspector.records.group.dispatchLabel')}
                value={dispatchSummary}
              />
              {selectedStep.rounds != null ? (
                <MetricPill
                  label={t('inspector.records.group.roundsLabel')}
                  value={String(selectedStep.rounds)}
                  mono
                />
              ) : null}
              {selectedStep.quorumCount != null ? (
                <MetricPill
                  label={t('inspector.records.group.quorumLabel')}
                  value={String(selectedStep.quorumCount)}
                  mono
                />
              ) : null}
            </div>
            <PayloadBlock
              testId="group-record-output"
              label={t('inspector.records.group.outputLabel')}
              value={
                activeAttempt?.outputJson ?? activeAttempt?.candidateOutputJson
              }
              defaultOpen
            />
          </div>
        );
      }

      case 'user_gate':
      case 'approval':
      case 'notify': {
        const interactionKind =
          selectedStep.kind === 'user_gate'
            ? selectedStep.interactionKind
            : selectedStep.kind;
        const severity =
          selectedStep.kind === 'user_gate'
            ? (selectedStep.severity ?? 'info')
            : 'info';
        const slaSeconds = selectedStep.slaTimeoutSeconds ?? null;
        const isWaitingApproval = activeAttempt?.status === 'waiting_approval';

        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <MetricPill
                label={t('inspector.records.gate.kindLabel')}
                value={t(`nodes.gateKinds.${interactionKind}`, {
                  defaultValue: interactionKind,
                })}
              />
              <MetricPill
                label={t('inspector.records.gate.severityLabel')}
                value={t(`inspector.userGate.severities.${severity}`)}
              />
              {slaSeconds != null ? (
                <MetricPill
                  label={t('inspector.records.gate.slaLabel')}
                  value={`${slaSeconds}s`}
                  mono
                />
              ) : null}
            </div>
            {isWaitingApproval && onDecideApproval ? (
              <div
                data-testid="gate-record-approval-actions"
                className="space-y-2 rounded-[var(--radius-element)] bg-warning/[0.08] p-2.5"
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  <span>{t('inspector.records.gate.pendingApproval')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 flex-1"
                    data-testid="records-approve-btn"
                    onClick={() =>
                      void onDecideApproval(selectedStep.id, {
                        approved: true,
                      })
                    }
                  >
                    <Check className="mr-1 size-3.5" />
                    {t('inspector.approve')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1"
                    data-testid="records-reject-btn"
                    onClick={() =>
                      void onDecideApproval(selectedStep.id, {
                        approved: false,
                      })
                    }
                  >
                    <X className="mr-1 size-3.5" />
                    {t('inspector.reject')}
                  </Button>
                </div>
              </div>
            ) : null}
            <PayloadBlock
              testId="gate-record-decision"
              label={t('inspector.records.gate.decisionLabel')}
              value={
                activeAttempt?.outputJson ?? activeAttempt?.candidateOutputJson
              }
              defaultOpen
            />
          </div>
        );
      }

      case 'control': {
        const outputObj = tryParseObject(
          activeAttempt?.outputJson ?? activeAttempt?.candidateOutputJson
        );
        const iterationValue =
          selectedStep.controlKind === 'bounded_loop'
            ? `${activeAttempt?.attempt?.toString() ?? '0'} / ${selectedStep.maxIterations ?? 3}`
            : null;

        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <MetricPill
                label={t('inspector.records.control.kindLabel')}
                value={t(`inspector.control.types.${selectedStep.controlKind}`)}
              />
              {iterationValue ? (
                <MetricPill
                  label={t('inspector.records.control.iterationsLabel')}
                  value={iterationValue}
                  mono
                />
              ) : null}
              {selectedStep.controlKind === 'wait_for_event' &&
              selectedStep.waitEventType ? (
                <MetricPill
                  label={t('inspector.records.control.waitEventLabel')}
                  value={selectedStep.waitEventType}
                  mono
                />
              ) : null}
              {selectedStep.controlKind === 'wait_for_event' &&
              selectedStep.timeoutSeconds != null ? (
                <MetricPill
                  label={t('inspector.records.control.timeoutLabel')}
                  value={`${selectedStep.timeoutSeconds}s`}
                  mono
                />
              ) : null}
            </div>
            {selectedStep.controlKind === 'condition' &&
            selectedStep.expression ? (
              <MetricPill
                label={t('inspector.records.control.expressionLabel')}
                value={
                  outputObj?.matched !== undefined
                    ? `${selectedStep.expression} → ${String(outputObj.matched)}`
                    : selectedStep.expression
                }
                mono
              />
            ) : null}
            <PayloadBlock
              testId="control-record-output"
              label={t('inspector.records.control.outputLabel')}
              value={
                activeAttempt?.outputJson ?? activeAttempt?.candidateOutputJson
              }
              defaultOpen
            />
          </div>
        );
      }

      case 'outbox_action': {
        const matchingOutbox: PulseOutboxEntryView[] = (
          outboxEntries ?? []
        ).filter((entry) => {
          if (entry.targetKind === selectedStep.actionKind) return true;
          if (
            selectedStep.destination &&
            entry.destination &&
            entry.destination.includes(selectedStep.destination)
          ) {
            return true;
          }
          return false;
        });

        return (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              <MetricPill
                label={t('inspector.records.outbox.channelLabel')}
                value={t(`nodes.outboxKinds.${selectedStep.actionKind}`, {
                  defaultValue: selectedStep.actionKind,
                })}
              />
              <MetricPill
                label={t('inspector.records.outbox.destinationLabel')}
                value={selectedStep.destination || '—'}
                mono
              />
            </div>
            <PayloadBlock
              testId="outbox-record-output"
              label={t('inspector.records.outbox.payloadLabel')}
              value={
                activeAttempt?.outputJson ??
                activeAttempt?.candidateOutputJson ??
                activeAttempt?.resolvedInputJson
              }
              defaultOpen
            />
            <div className="space-y-1.5 rounded-[var(--radius-element)] bg-muted/35 p-2.5">
              <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Send className="size-3 text-success" />
                  {t('inspector.records.outbox.recentDispatches')}
                </span>
                <span className="font-mono tabular-nums">
                  {matchingOutbox.length}
                </span>
              </div>
              {matchingOutbox.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/80">
                  {t('inspector.records.outbox.noDispatches')}
                </p>
              ) : (
                <ul className="max-h-32 space-y-1 overflow-auto">
                  {matchingOutbox.slice(0, 5).map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-[var(--radius-inner)] bg-background/60 px-2 py-1 text-[11px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-foreground">
                          {entry.status} · {entry.attempts}x
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {formatShortTime(entry.updatedAt)}
                        </span>
                      </div>
                      {entry.lastError ? (
                        <div className="mt-0.5 truncate text-[10.5px] text-destructive">
                          {entry.lastError}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      }
      case 'agent':
      case 'session':
        return null;
    }
  };

  const renderCategoryIcon = () => {
    switch (presentation.category) {
      case 'trigger':
        return <Zap className="size-3.5 text-info" />;
      case 'bot':
        return <Activity className="size-3.5 text-primary" />;
      case 'group_stage':
        return <Users className="size-3.5 text-primary" />;
      case 'user_gate':
        return selectedStep.kind === 'notify' ? (
          <Bell className="size-3.5 text-warning" />
        ) : (
          <ShieldCheck className="size-3.5 text-warning" />
        );
      case 'control':
        return selectedStep.kind === 'control' &&
          selectedStep.controlKind === 'bounded_loop' ? (
          <Repeat className="size-3.5 text-info" />
        ) : selectedStep.kind === 'control' &&
          selectedStep.controlKind === 'wait_for_event' ? (
          <Clock className="size-3.5 text-info" />
        ) : (
          <GitFork className="size-3.5 text-info" />
        );
      case 'outbox_action':
        return <Send className="size-3.5 text-success" />;
      case 'session':
        return null;
    }
  };

  return (
    <div
      data-testid="workflow-step-records"
      data-record-kind={presentation.category}
      className="flex h-full min-h-0 flex-col gap-2.5 overflow-auto px-1 py-0.5"
    >
      {runSwitcherBar}

      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-element)] bg-muted/45 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {renderCategoryIcon()}
          <span
            className={cn(
              'workflow-node-status-dot',
              statusDotClass(effectiveStatus)
            )}
          />
          <span
            data-testid="step-records-status"
            className="truncate text-xs font-medium text-foreground"
          >
            {statusLabel}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">
          {activeAttempt?.completedAt
            ? formatShortTime(activeAttempt.completedAt)
            : activeAttempt?.startedAt
              ? formatShortTime(activeAttempt.startedAt)
              : run
                ? formatShortTime(run.updatedAt)
                : t('studio.standby')}
        </span>
      </div>

      {renderCategoryBody()}

      <DurableEventList
        events={correlatedEvents}
        title={t('inspector.records.auditEvents')}
        emptyLabel={t('inspector.records.noAuditEvents')}
      />
    </div>
  );
}
