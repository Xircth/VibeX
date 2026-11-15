import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, GitBranch, GitFork, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  pulseApi,
  type EventSourceKind,
  type GateFilterCondition,
  type PulseEvalMode,
  type PulseRuleSpec,
  type PulseRuleView,
  type PulseTargetSpec,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { requestOpenWorkflowStudio } from './pulseDeckEvents';

export type ScenarioTemplateId =
  | 'github_triage'
  | 'jira_bug'
  | 'cron_digest'
  | 'webhook_workflow';

type ComposerTargetKind = 'session' | 'bot' | 'workflow';

const COMPOSER_SOURCES: readonly EventSourceKind[] = [
  'github',
  'jira',
  'feishu',
  'webhook_standard',
  'time_cron',
];

const DEFAULT_EVENT_BY_SOURCE: Record<EventSourceKind, string> = {
  github: 'github.issues.opened',
  jira: 'jira.issue.created',
  feishu: 'feishu.im.message.receive_v1',
  webhook_standard: 'webhook.ingest',
  webhook_custom: 'webhook.custom',
  time_cron: 'time.cron.tick',
  time_once: 'time.once.fired',
  time_interval: 'time.interval.tick',
  time_sla: 'time.sla.expired',
  sdk_custom: 'sdk.custom',
  system_internal: 'system.internal',
};

export interface PulseDeckRuleComposerProps {
  projectId?: string | null;
  onCancel: () => void;
  onCreated: (rule: PulseRuleView) => void;
  onError: (message: string) => void;
}

export function PulseDeckRuleComposer({
  projectId = null,
  onCancel,
  onCreated,
  onError,
}: PulseDeckRuleComposerProps) {
  const { t } = useTranslation('panels');

  const [activeTemplate, setActiveTemplate] =
    useState<ScenarioTemplateId | null>('github_triage');
  const [ruleName, setRuleName] = useState(() =>
    t('pulseDeck.tplGithubTitle')
  );
  const [sourceKind, setSourceKind] = useState<EventSourceKind>('github');
  const [eventType, setEventType] = useState('github.issues.opened');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [filterPointer, setFilterPointer] = useState('');
  const [filterValue, setFilterValue] = useState('');

  const [targetKind, setTargetKind] = useState<ComposerTargetKind>('session');
  const [promptTemplate, setPromptTemplate] = useState(() =>
    t('pulseDeck.tplGithubPrompt')
  );
  const [botMemberId, setBotMemberId] = useState('triage-bot');
  const [workflowId, setWorkflowId] = useState('wf-webhook-triage');
  const [evalMode, setEvalMode] = useState<PulseEvalMode>('observe');
  const [saving, setSaving] = useState(false);

  const applyTemplate = (templateId: ScenarioTemplateId) => {
    setActiveTemplate(templateId);
    switch (templateId) {
      case 'github_triage':
        setRuleName(t('pulseDeck.tplGithubTitle'));
        setSourceKind('github');
        setEventType('github.issues.opened');
        setFilterPointer('');
        setFilterValue('');
        setTargetKind('session');
        setPromptTemplate(t('pulseDeck.tplGithubPrompt'));
        setEvalMode('observe');
        break;
      case 'jira_bug':
        setRuleName(t('pulseDeck.tplJiraTitle'));
        setSourceKind('jira');
        setEventType('jira.issue.created');
        setFilterPointer('/issue/fields/issuetype/name');
        setFilterValue('Bug');
        setTargetKind('session');
        setPromptTemplate(t('pulseDeck.tplJiraPrompt'));
        setEvalMode('observe');
        break;
      case 'cron_digest':
        setRuleName(t('pulseDeck.tplCronTitle'));
        setSourceKind('time_cron');
        setEventType('time.cron.tick');
        setCronExpr('0 9 * * *');
        setFilterPointer('');
        setFilterValue('');
        setTargetKind('session');
        setPromptTemplate(t('pulseDeck.tplCronPrompt'));
        setEvalMode('observe');
        break;
      case 'webhook_workflow':
        setRuleName(t('pulseDeck.tplWebhookTitle'));
        setSourceKind('webhook_standard');
        setEventType('webhook.ingest');
        setFilterPointer('');
        setFilterValue('');
        setTargetKind('workflow');
        setWorkflowId('wf-webhook-triage');
        setPromptTemplate(t('pulseDeck.tplWebhookPrompt'));
        setEvalMode('observe');
        break;
    }
  };

  const handleSourceSelect = (nextKind: EventSourceKind) => {
    setSourceKind(nextKind);
    setEventType(DEFAULT_EVENT_BY_SOURCE[nextKind]);
  };

  const canSave =
    Boolean(ruleName.trim()) &&
    (sourceKind === 'time_cron'
      ? Boolean(cronExpr.trim())
      : Boolean(eventType.trim())) &&
    (targetKind === 'workflow'
      ? Boolean(workflowId.trim())
      : targetKind === 'bot'
        ? Boolean(botMemberId.trim()) && Boolean(promptTemplate.trim())
        : Boolean(promptTemplate.trim()));

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    onError('');

    const conditions: GateFilterCondition[] =
      sourceKind === 'time_cron' ? [] : [{ op: 'not_bot_actor' }];
    if (filterPointer.trim()) {
      conditions.push({
        op: 'eq',
        pointer: filterPointer.trim(),
        value: filterValue,
      });
    }

    const target: PulseTargetSpec =
      targetKind === 'workflow'
        ? {
            kind: 'workflow',
            workflowId: workflowId.trim(),
            pinnedVersion: 1,
            inputMapping: {},
          }
        : targetKind === 'bot'
          ? {
              kind: 'bot',
              memberId: botMemberId.trim(),
              conversationScope: 'per_thread_topic',
              mailboxPolicy: 'fifo_serial',
              subscribeThread: true,
              promptTemplate: promptTemplate.trim(),
            }
          : {
              kind: 'session',
              mode: 'ephemeral_fresh',
              agentId: 'claude-code',
              workspaceIsolation: 'isolated_worktree',
              projectId,
              subscribeThread: true,
              promptTemplate: promptTemplate.trim(),
            };

    const spec: PulseRuleSpec = {
      name: ruleName.trim(),
      description: null,
      projectId,
      evalMode,
      orchestrator: 'direct_reflex',
      filter: {
        sourceKinds: [sourceKind],
        sourceInstanceIds: [],
        eventTypes:
          sourceKind === 'time_cron'
            ? ['time.cron.tick']
            : [eventType.trim()],
        allowedActors: [],
        conditions,
      },
      temporal:
        sourceKind === 'time_cron'
          ? {
              kind: 'cron',
              expression: cronExpr.trim(),
              timezone: 'UTC',
            }
          : null,
      targets: [target],
    };

    try {
      const apiWithCompat = pulseApi as typeof pulseApi & {
        upsertRule?: (input: {
          spec: PulseRuleSpec;
          projectId?: string | null;
        }) => Promise<PulseRuleView>;
      };
      const saved = apiWithCompat.upsertRule
        ? await apiWithCompat.upsertRule({ spec, projectId })
        : await pulseApi.saveRule({
            enabled: evalMode !== 'off',
            spec,
          });
      const fallbackRule: PulseRuleView = saved ?? {
        id: `rule-${Date.now()}`,
        enabled: evalMode !== 'off',
        draftOnly: false,
        mandateOrigin: 'explicit_human',
        revision: 1,
        matchedCount: 0,
        observedCount: 0,
        updatedAt: new Date().toISOString(),
        spec,
      };
      onCreated(fallbackRule);
    } catch (err) {
      onError(err instanceof Error ? err.message : t('pulseDeck.errSaveRule'));
    } finally {
      setSaving(false);
    }
  };

  const templates: ReadonlyArray<{
    id: ScenarioTemplateId;
    title: string;
    desc: string;
  }> = [
    {
      id: 'github_triage',
      title: t('pulseDeck.tplGithubTitle'),
      desc: t('pulseDeck.tplGithubDesc'),
    },
    {
      id: 'jira_bug',
      title: t('pulseDeck.tplJiraTitle'),
      desc: t('pulseDeck.tplJiraDesc'),
    },
    {
      id: 'cron_digest',
      title: t('pulseDeck.tplCronTitle'),
      desc: t('pulseDeck.tplCronDesc'),
    },
    {
      id: 'webhook_workflow',
      title: t('pulseDeck.tplWebhookTitle'),
      desc: t('pulseDeck.tplWebhookDesc'),
    },
  ];

  return (
    <section
      className="settings-surface space-y-3 rounded-lg border border-border bg-popover p-3.5 text-xs"
      data-testid="pulse-rule-composer"
      aria-label={t('pulseDeck.composerTitle')}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          {t('pulseDeck.composerTitle')}
        </h3>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t('pulseDeck.composerCancel')}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">
          {t('pulseDeck.composerTemplatesLabel')}
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
          {templates.map((tpl) => {
            const active = activeTemplate === tpl.id;
            return (
              <button
                key={tpl.id}
                type="button"
                data-testid={`pulse-template-${tpl.id}`}
                onClick={() => applyTemplate(tpl.id)}
                className={cn(
                  'rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/10 text-foreground ring-1 ring-primary'
                    : 'bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <div className="font-medium text-foreground">{tpl.title}</div>
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                  {tpl.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 border-t border-border/60 pt-2.5 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="pulse-composer-rule-name" className="text-[11px]">
            {t('pulseDeck.composerRuleName')}
          </Label>
          <Input
            id="pulse-composer-rule-name"
            aria-label={t('pulseDeck.composerRuleName')}
            placeholder={t('pulseDeck.composerRuleNamePlaceholder')}
            value={ruleName}
            onChange={(event) => setRuleName(event.target.value)}
            className="h-7 px-2 text-xs"
          />
        </div>

        <div className="space-y-1">
          <Label
            htmlFor="pulse-composer-event-or-cron"
            className="text-[11px]"
          >
            {sourceKind === 'time_cron'
              ? t('pulseDeck.composerCronExpr')
              : t('pulseDeck.composerEventType')}
          </Label>
          {sourceKind === 'time_cron' ? (
            <Input
              id="pulse-composer-event-or-cron"
              aria-label={t('pulseDeck.composerCronExpr')}
              placeholder={t('pulseDeck.composerCronPlaceholder')}
              value={cronExpr}
              onChange={(event) => setCronExpr(event.target.value)}
              className="h-7 px-2 font-mono text-xs tabular-nums"
            />
          ) : (
            <Input
              id="pulse-composer-event-or-cron"
              aria-label={t('pulseDeck.composerEventType')}
              placeholder={t('pulseDeck.composerEventTypePlaceholder')}
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              className="h-7 px-2 font-mono text-xs"
            />
          )}
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-medium text-muted-foreground">
          {t('pulseDeck.composerTriggerSource')}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {COMPOSER_SOURCES.map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`pulse-composer-source-${kind}`}
              onClick={() => handleSourceSelect(kind)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                sourceKind === kind
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:text-foreground'
              )}
            >
              {t(
                `pulseDeck.sources.${kind.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())}`
              )}
            </button>
          ))}
          {filterPointer ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
              {t('pulseDeck.composerConditionChip', {
                pointer: filterPointer,
                value: filterValue,
              })}
              <button
                type="button"
                aria-label={t('pulseDeck.composerClearConditionAria')}
                onClick={() => {
                  setFilterPointer('');
                  setFilterValue('');
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 border-t border-border/60 pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('pulseDeck.composerTargetLabel')}
          </span>
          <div className="inline-flex flex-wrap gap-1">
            {(
              [
                ['session', GitBranch, t('pulseDeck.composerTargetSession')],
                ['bot', Bot, t('pulseDeck.composerTargetBot')],
                ['workflow', GitFork, t('pulseDeck.composerTargetWorkflow')],
              ] as const
            ).map(([kind, Icon, label]) => (
              <button
                key={kind}
                type="button"
                data-testid={`pulse-composer-target-${kind}`}
                onClick={() => setTargetKind(kind)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  targetKind === kind
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-3 w-3" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {targetKind === 'workflow' ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1 space-y-1">
              <Label htmlFor="pulse-composer-workflow-id" className="text-[11px]">
                {t('pulseDeck.composerWorkflowIdLabel')}
              </Label>
              <Input
                id="pulse-composer-workflow-id"
                aria-label={t('pulseDeck.composerWorkflowIdLabel')}
                placeholder={t('pulseDeck.composerWorkflowIdPlaceholder')}
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
                className="h-7 px-2 font-mono text-xs"
              />
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              data-testid="pulse-composer-open-workflow"
              icon={<GitFork className="h-3 w-3" />}
              onClick={() =>
                requestOpenWorkflowStudio({
                  definitionId: workflowId.trim() || null,
                })
              }
            >
              {t('pulseDeck.composerOpenWorkflowBtn')}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {targetKind === 'bot' ? (
              <div className="space-y-1">
                <Label htmlFor="pulse-composer-bot-id" className="text-[11px]">
                  {t('pulseDeck.composerBotIdLabel')}
                </Label>
                <Input
                  id="pulse-composer-bot-id"
                  aria-label={t('pulseDeck.composerBotIdLabel')}
                  placeholder={t('pulseDeck.composerBotIdPlaceholder')}
                  value={botMemberId}
                  onChange={(event) => setBotMemberId(event.target.value)}
                  className="h-7 px-2 font-mono text-xs"
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="pulse-composer-prompt" className="text-[11px]">
                {t('pulseDeck.composerPromptLabel')}
              </Label>
              <Textarea
                id="pulse-composer-prompt"
                aria-label={t('pulseDeck.composerPromptLabel')}
                placeholder={t('pulseDeck.composerPromptPlaceholder')}
                value={promptTemplate}
                onChange={(event) => setPromptTemplate(event.target.value)}
                className="min-h-[56px] px-2 py-1.5 text-xs"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('pulseDeck.composerRunModeLabel')}
          </span>
          {(['observe', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`pulse-composer-mode-${mode}`}
              onClick={() => setEvalMode(mode)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                evalMode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:text-foreground'
              )}
            >
              {mode === 'observe'
                ? t('pulseDeck.composerModeObserve')
                : t('pulseDeck.composerModeAuto')}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onCancel}
          >
            {t('pulseDeck.composerCancel')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="primary"
            data-testid="pulse-composer-save-btn"
            disabled={!canSave || saving}
            onClick={() => void handleSave()}
          >
            {saving ? t('pulseDeck.composerSaving') : t('pulseDeck.composerSave')}
          </Button>
        </div>
      </div>
    </section>
  );
}
