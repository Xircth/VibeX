import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Bot, Check, GitBranch, Link2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { sessionsApi } from '@/lib/api/sessions';
import {
  pulseApi,
  type EventEnvelope,
  type EventSourceKind,
  type PulseEvalMode,
  type PulseRuleSpec,
  type PulseTargetSpec,
} from '@/lib/api/pulse';
import { evaluatePulseRuleLocally } from '@/lib/pulseFilterEvaluator';
import { cn } from '@/lib/utils';

export interface CreatePulseTicketSessionParams {
  prompt: string;
  threadKey: string | null;
  agentId: string;
}

export interface IssuePulseDispatchPopoverProps {
  projectId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  sessionTitle?: string | null;
  branchName?: string | null;
  agentId?: string | null;
  compactIconOnly?: boolean;
  triggerClassName?: string;
  triggerTestId?: string;
  isPulseDeckOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreateTicketSession?: (
    params: CreatePulseTicketSessionParams
  ) => Promise<string | null>;
  onCreateFreshSession?: () => void;
  onOpenPulseDeck?: () => void;
  onDispatched?: () => void;
}

export function normalizePulseAgentId(raw?: string | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'claude-code';
  return trimmed.toLowerCase().replace(/_/g, '-');
}

function toBackendExecutorName(agentId: string): string {
  return agentId.trim().toUpperCase().replace(/-/g, '_') || 'CLAUDE_CODE';
}

type DispatchTab = 'one_shot' | 'automate_similar';
type DispatchTargetKind = 'session' | 'bot';

const ISSUE_SOURCES: ReadonlyArray<{
  kind: EventSourceKind;
  defaultEventType: string;
  defaultPointer: string;
  defaultValue: string;
}> = [
  {
    kind: 'jira',
    defaultEventType: 'jira.issue.created',
    defaultPointer: '/issue/fields/issuetype/name',
    defaultValue: 'Bug',
  },
  {
    kind: 'github',
    defaultEventType: 'github.issues.opened',
    defaultPointer: '/action',
    defaultValue: 'opened',
  },
  {
    kind: 'feishu',
    defaultEventType: 'feishu.im.message.receive_v1',
    defaultPointer: '/message/chat_type',
    defaultValue: 'group',
  },
  {
    kind: 'webhook_standard',
    defaultEventType: 'webhook.issue.ingest',
    defaultPointer: '/severity',
    defaultValue: 'high',
  },
];

function buildSampleIssueEnvelope(
  sourceKind: EventSourceKind,
  eventType: string,
  pointer: string,
  expectedValue: string,
  threadKey: string | null
): EventEnvelope {
  const payload: Record<string, unknown> = {
    title: 'Sample inbound issue',
    action: expectedValue || 'opened',
    severity: expectedValue || 'high',
    issue: {
      key: 'PROJ-101',
      fields: {
        issuetype: { name: expectedValue || 'Bug' },
      },
    },
    message: {
      chat_type: expectedValue || 'group',
    },
  };

  if (pointer.startsWith('/') && pointer.length > 1) {
    const segments = pointer.slice(1).split('/');
    let cursor: Record<string, unknown> = payload;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!;
      const existing = cursor[seg];
      if (
        !existing ||
        typeof existing !== 'object' ||
        Array.isArray(existing)
      ) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1];
    if (leaf) {
      cursor[leaf] = expectedValue;
    }
  }

  return {
    eventId: 'evt-sample-issue',
    deliveryId: 'dlv-sample-issue',
    source: {
      kind: sourceKind,
      instanceId: 'default',
      trustLevel: 'verified_external',
    },
    eventType,
    occurredAt: new Date(0).toISOString(),
    actor: {
      id: 'reporter-1',
      displayName: 'Issue Reporter',
      roles: ['developer'],
      isBot: false,
      isSelf: false,
    },
    threadKey,
    correlations: [],
    replyChannels: [],
    trace: {
      rootEventId: 'evt-sample-issue',
      parentRunId: null,
      hopCount: 0,
    },
    payload,
  };
}

export function IssuePulseDispatchPopover({
  projectId = null,
  workspaceId = null,
  sessionId = null,
  sessionTitle = null,
  branchName = null,
  agentId = null,
  compactIconOnly = false,
  triggerClassName,
  triggerTestId = 'issue-pulse-dispatch-trigger',
  isPulseDeckOpen = false,
  onOpenChange,
  onCreateTicketSession,
  onCreateFreshSession,
  onOpenPulseDeck,
  onDispatched,
}: IssuePulseDispatchPopoverProps) {
  const { t } = useTranslation('panels');

  const [open, setOpen] = useState(false);
  const handlePopoverOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const [tab, setTab] = useState<DispatchTab>('one_shot');
  const [targetKind, setTargetKind] = useState<DispatchTargetKind>('session');
  const [botMemberId, setBotMemberId] = useState('triage-bot');
  const [ticketPrompt, setTicketPrompt] = useState(
    () =>
      sessionTitle?.trim() ||
      (branchName
        ? t('pulseDispatch.defaultBranchPrompt', { branch: branchName })
        : t('pulseDispatch.defaultIssuePrompt'))
  );
  const [externalThreadKey, setExternalThreadKey] = useState(() =>
    branchName ? `github:${branchName}` : 'jira:PROJ-101'
  );
  const [subscribeThread, setSubscribeThread] = useState(true);

  const [sourceKind, setSourceKind] = useState<EventSourceKind>('jira');
  const [ruleName, setRuleName] = useState(() =>
    sessionTitle?.trim()
      ? t('pulseDispatch.defaultRuleNamePrefix', {
          title: sessionTitle.trim().slice(0, 36),
        })
      : t('pulseDispatch.defaultRuleName')
  );
  const [evalMode, setEvalMode] = useState<PulseEvalMode>('observe');
  const [filterPointer, setFilterPointer] = useState(
    '/issue/fields/issuetype/name'
  );
  const [filterValue, setFilterValue] = useState('Bug');

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedSourceMeta =
    ISSUE_SOURCES.find((item) => item.kind === sourceKind) ?? ISSUE_SOURCES[0]!;
  const resolvedAgent = normalizePulseAgentId(agentId);

  const candidateSpec = useMemo<PulseRuleSpec>(() => {
    const target: PulseTargetSpec =
      targetKind === 'session'
        ? {
            kind: 'session',
            mode: 'ephemeral_fresh',
            agentId: resolvedAgent,
            workspaceIsolation: 'isolated_worktree',
            projectId,
            subscribeThread,
            promptTemplate:
              ticketPrompt.trim() ||
              'Triage issue {{threadKey}}: {{payload.title}}',
          }
        : {
            kind: 'bot',
            memberId: botMemberId.trim(),
            conversationScope: 'per_thread_topic',
            mailboxPolicy: 'fifo_serial',
            subscribeThread,
            promptTemplate:
              ticketPrompt.trim() ||
              'Triage issue {{threadKey}}: {{payload.title}}',
          };

    return {
      name: ruleName,
      description: branchName
        ? t('pulseDispatch.scopedFromBranch', { branch: branchName })
        : null,
      projectId,
      workspaceId,
      evalMode,
      orchestrator: 'direct_reflex',
      filter: {
        sourceKinds: [sourceKind],
        sourceInstanceIds: [],
        eventTypes: [selectedSourceMeta.defaultEventType],
        allowedActors: [],
        conditions: [
          { op: 'not_bot_actor' },
          ...(filterPointer.trim()
            ? [
                {
                  op: 'eq' as const,
                  pointer: filterPointer.trim(),
                  value: filterValue,
                },
              ]
            : []),
        ],
      },
      temporal: null,
      targets: [target],
    };
  }, [
    botMemberId,
    branchName,
    evalMode,
    filterPointer,
    filterValue,
    projectId,
    resolvedAgent,
    ruleName,
    selectedSourceMeta.defaultEventType,
    sourceKind,
    subscribeThread,
    t,
    targetKind,
    ticketPrompt,
    workspaceId,
  ]);

  const dryRun = useMemo(() => {
    const sample = buildSampleIssueEnvelope(
      sourceKind,
      selectedSourceMeta.defaultEventType,
      filterPointer.trim(),
      filterValue,
      externalThreadKey.trim() || null
    );
    return evaluatePulseRuleLocally(candidateSpec, sample);
  }, [
    candidateSpec,
    externalThreadKey,
    filterPointer,
    filterValue,
    selectedSourceMeta.defaultEventType,
    sourceKind,
  ]);

  const handleSelectSource = (nextKind: EventSourceKind) => {
    setSourceKind(nextKind);
    const meta = ISSUE_SOURCES.find((item) => item.kind === nextKind);
    if (meta) {
      setFilterPointer(meta.defaultPointer);
      setFilterValue(meta.defaultValue);
    }
  };

  const handleDispatchOneShot = async () => {
    const trimmedPrompt = ticketPrompt.trim();
    if (!trimmedPrompt) return;

    setSubmitting(true);
    setFeedback(null);
    setErrorMessage(null);
    try {
      const normalizedThread = externalThreadKey.trim();
      let resolvedSessionId: string | null = sessionId?.trim() || null;

      if (targetKind === 'session') {
        if (onCreateTicketSession) {
          const createdId = await onCreateTicketSession({
            prompt: trimmedPrompt,
            threadKey: normalizedThread || null,
            agentId: resolvedAgent,
          });
          if (createdId?.trim()) {
            resolvedSessionId = createdId.trim();
          }
        } else if (!resolvedSessionId) {
          const sessionName =
            sessionTitle?.trim() || trimmedPrompt.slice(0, 60);
          if (projectId) {
            const created = await sessionsApi.createProject({
              project_id: projectId,
              workspace_id: workspaceId ?? null,
              executor: toBackendExecutorName(resolvedAgent),
              name: sessionName,
              initial_prompt: trimmedPrompt,
              create_workspace: !workspaceId,
            });
            resolvedSessionId = created?.id?.trim() || null;
          } else if (workspaceId) {
            const created = await sessionsApi.create({
              workspace_id: workspaceId,
              executor: toBackendExecutorName(resolvedAgent),
              name: sessionName,
              initial_prompt: trimmedPrompt,
            });
            resolvedSessionId = created?.id?.trim() || null;
          } else {
            await pulseApi.saveRule({
              enabled: true,
              spec: {
                ...candidateSpec,
                name: t('pulseDispatch.oneShotRulePrefix', {
                  prompt: trimmedPrompt.slice(0, 44),
                }),
                evalMode: 'auto',
                filter: {
                  sourceKinds: ['sdk_custom'],
                  sourceInstanceIds: [],
                  eventTypes: ['kanban.issue.dispatched'],
                  allowedActors: [],
                  conditions: [],
                },
              },
            });
          }
          onCreateFreshSession?.();
        } else {
          onCreateFreshSession?.();
        }
      }

      const botTargetId = botMemberId.trim() || 'triage-bot';

      await pulseApi.emitCustomEvent({
        eventType: 'kanban.issue.dispatched',
        threadKey: normalizedThread || null,
        payload: {
          projectId,
          workspaceId,
          sessionId: resolvedSessionId,
          branchName,
          targetKind,
          agentId: targetKind === 'session' ? resolvedAgent : null,
          botMemberId: targetKind === 'bot' ? botTargetId : null,
          workspaceIsolation:
            targetKind === 'session' ? 'isolated_worktree' : null,
          prompt: trimmedPrompt,
        },
      });

      if (subscribeThread && normalizedThread) {
        if (targetKind === 'bot') {
          await pulseApi.subscribeThread(normalizedThread, 'bot', botTargetId);
        } else if (resolvedSessionId) {
          await pulseApi.subscribeThread(
            normalizedThread,
            'session',
            resolvedSessionId
          );
        }
      }

      setFeedback(
        subscribeThread && normalizedThread
          ? t('pulseDispatch.feedbackDispatchedSubscribed', {
              threadKey: normalizedThread,
            })
          : t('pulseDispatch.feedbackDispatched')
      );
      onDispatched?.();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : t('pulseDispatch.errDispatch')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveSimilarRule = async () => {
    if (!dryRun.valid) {
      setErrorMessage(
        dryRun.violations.map((item) => item.message).join(' · ')
      );
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    setErrorMessage(null);
    try {
      const saved = await pulseApi.saveRule({
        enabled: evalMode !== 'off',
        spec: candidateSpec,
      });
      setFeedback(
        t('pulseDispatch.feedbackSavedRule', {
          name: saved.spec.name,
          mode: t(`pulseDeck.modes.${saved.spec.evalMode}`),
        })
      );
      onDispatched?.();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : t('pulseDispatch.errSaveRule')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handlePopoverOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compactIconOnly ? 'icon' : 'xs'}
          className={cn(
            triggerClassName ??
              (compactIconOnly
                ? 'session-hub-action-button h-7 w-7 p-0 shadow-none'
                : 'h-7 gap-1 px-2 text-xs font-medium shadow-none'),
            isPulseDeckOpen && 'bg-muted text-foreground'
          )}
          aria-label={t('pulseDispatch.triggerAria')}
          data-testid={triggerTestId}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Zap className="h-3.5 w-3.5 text-primary" />
          {compactIconOnly ? null : (
            <span>{t('pulseDispatch.triggerLabel')}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[340px] space-y-3 border border-border bg-popover p-3 text-foreground shadow-md"
        data-testid="issue-pulse-dispatch-popover"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <Zap className="h-3.5 w-3.5 text-primary" />
            <span>{t('pulseDispatch.title')}</span>
          </div>
          {onOpenPulseDeck ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6 gap-1 px-2 text-[11px]"
              data-testid="issue-pulse-open-deck-btn"
              onClick={() => {
                handlePopoverOpenChange(false);
                onOpenPulseDeck();
              }}
            >
              <Activity className="h-3 w-3" />
              <span>
                {isPulseDeckOpen
                  ? t('pulseDispatch.closeDeck')
                  : t('pulseDispatch.openDeck')}
              </span>
            </Button>
          ) : null}
        </div>

        <div
          className="grid grid-cols-2 gap-1 rounded-md bg-muted/50 p-0.5"
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'one_shot'}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              tab === 'one_shot'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => {
              setTab('one_shot');
              setFeedback(null);
              setErrorMessage(null);
            }}
          >
            {t('pulseDispatch.tabOneShot')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'automate_similar'}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium transition-colors',
              tab === 'automate_similar'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => {
              setTab('automate_similar');
              setFeedback(null);
              setErrorMessage(null);
            }}
          >
            {t('pulseDispatch.tabAutomateSimilar')}
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t('pulseDispatch.executionTarget')}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="dispatch-target-session"
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                targetKind === 'session'
                  ? 'border-primary bg-muted text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setTargetKind('session')}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {t('pulseDispatch.freshSession')}
              </span>
            </button>
            <button
              type="button"
              data-testid="dispatch-target-bot"
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                targetKind === 'bot'
                  ? 'border-primary bg-muted text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setTargetKind('bot')}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {t('pulseDispatch.persistentBot')}
              </span>
            </button>
          </div>

          {targetKind === 'bot' ? (
            <input
              type="text"
              aria-label={t('pulseDispatch.botMemberIdAria')}
              value={botMemberId}
              onChange={(event) => setBotMemberId(event.target.value)}
              placeholder={t('pulseDispatch.botMemberIdPlaceholder')}
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none"
            />
          ) : (
            <div className="text-[11px] text-muted-foreground">
              {t('pulseDispatch.isolatedWorktreeHint')}
            </div>
          )}
        </div>

        {tab === 'one_shot' ? (
          <div className="space-y-2.5">
            <div className="space-y-1">
              <label
                htmlFor="dispatch-ticket-prompt"
                className="text-[11px] font-medium text-muted-foreground"
              >
                {t('pulseDispatch.dispatchInstruction')}
              </label>
              <textarea
                id="dispatch-ticket-prompt"
                rows={2}
                value={ticketPrompt}
                onChange={(event) => setTicketPrompt(event.target.value)}
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="dispatch-thread-key"
                className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
              >
                <Link2 className="h-3 w-3" />
                <span>{t('pulseDispatch.externalThreadKey')}</span>
              </label>
              <input
                id="dispatch-thread-key"
                type="text"
                value={externalThreadKey}
                onChange={(event) => setExternalThreadKey(event.target.value)}
                placeholder={t('pulseDispatch.externalThreadPlaceholder')}
                className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus:outline-none"
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
              <Checkbox
                checked={subscribeThread}
                onCheckedChange={(checked) =>
                  setSubscribeThread(Boolean(checked))
                }
                aria-label={t('pulseDispatch.subscribeThread')}
              />
              <span className="text-foreground">
                {t('pulseDispatch.subscribeThread')}
              </span>
            </label>

            <Button
              type="button"
              size="xs"
              className="h-7 w-full text-xs"
              disabled={submitting || !ticketPrompt.trim()}
              data-testid="dispatch-one-shot-submit"
              onClick={() => void handleDispatchOneShot()}
            >
              {submitting
                ? t('pulseDispatch.dispatching')
                : t('pulseDispatch.dispatchBtn')}
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="space-y-1">
              <label
                htmlFor="dispatch-rule-name"
                className="text-[11px] font-medium text-muted-foreground"
              >
                {t('pulseDispatch.ruleName')}
              </label>
              <input
                id="dispatch-rule-name"
                type="text"
                value={ruleName}
                onChange={(event) => setRuleName(event.target.value)}
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-4 gap-1">
              {ISSUE_SOURCES.map((source) => (
                <button
                  key={source.kind}
                  type="button"
                  onClick={() => handleSelectSource(source.kind)}
                  className={cn(
                    'rounded border px-1.5 py-1 text-[11px] font-medium transition-colors',
                    sourceKind === source.kind
                      ? 'border-primary bg-muted text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(
                    `pulseFilter.sources.${source.kind.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
                  )}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <input
                type="text"
                aria-label={t('pulseDispatch.jsonPointerAria')}
                value={filterPointer}
                onChange={(event) => setFilterPointer(event.target.value)}
                placeholder="/issue/priority"
                className="h-7 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground focus:outline-none"
              />
              <input
                type="text"
                aria-label={t('pulseDispatch.expectedValueAria')}
                value={filterValue}
                onChange={(event) => setFilterValue(event.target.value)}
                placeholder={t('pulseDispatch.expectedValuePlaceholder')}
                className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('pulseDispatch.rolloutMode')}
              </span>
              <div className="flex items-center gap-1">
                {(['off', 'observe', 'auto'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setEvalMode(mode)}
                    className={cn(
                      'rounded border px-2 py-0.5 text-[11px] font-medium',
                      evalMode === mode
                        ? 'border-primary bg-muted text-foreground'
                        : 'border-border bg-background text-muted-foreground'
                    )}
                  >
                    {t(`pulseDeck.modes.${mode}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-[11px]">
              <span className="text-muted-foreground">
                {t('pulseDispatch.dryRunCheck')}
              </span>
              <span
                className={cn(
                  'font-medium tabular-nums',
                  !dryRun.valid
                    ? 'text-destructive'
                    : dryRun.matched
                      ? 'text-success'
                      : 'text-warning'
                )}
                data-testid="dispatch-dry-run-status"
              >
                {!dryRun.valid
                  ? t('pulseDispatch.dryRunInvalid', {
                      count: dryRun.violations.length,
                    })
                  : dryRun.matched
                    ? t('pulseDispatch.dryRunMatched')
                    : t('pulseDispatch.dryRunFiltered')}
              </span>
            </div>

            {dryRun.violations.length > 0 ? (
              <ul className="space-y-0.5 text-[11px] text-destructive">
                {dryRun.violations.map((v) => (
                  <li key={`${v.path}-${v.code}`}>
                    {v.path}: {v.message}
                  </li>
                ))}
              </ul>
            ) : null}

            <Button
              type="button"
              size="xs"
              className="h-7 w-full text-xs"
              disabled={submitting || !dryRun.valid}
              data-testid="dispatch-save-similar-rule"
              onClick={() => void handleSaveSimilarRule()}
            >
              {submitting
                ? t('pulseDispatch.saving')
                : t('pulseDispatch.saveAutomationRule')}
            </Button>
          </div>
        )}

        {feedback ? (
          <div
            role="status"
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px] text-foreground"
          >
            <Check className="h-3 w-3 shrink-0 text-success" />
            <span className="truncate">{feedback}</span>
          </div>
        ) : null}

        {errorMessage ? (
          <div
            role="alert"
            className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
