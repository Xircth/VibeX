import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, MessageSquare, Send, Users, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useManagedAgentOptions } from '@/features/agent-management';
import type {
  BotMailboxPolicy,
  EventEnvelope,
  PulseCallbackKind,
  PulseCallbackSpec,
  PulseOutboxEntryView,
  PulseRuleSpec,
  PulseRuleView,
  PulseTargetSpec,
  PulseWorkspaceIsolation,
  SessionTargetMode,
  UserInteractionKind,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import {
  buildSampleEnvelopeForRule,
  PROMPT_VARIABLE_PILLS,
  renderTemplatePreview,
} from './automationModels';

const FALLBACK_AGENTS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
] as const;

export function FastTaskTargetEditor({
  spec,
  onChange,
}: {
  spec: PulseRuleSpec;
  onChange: (next: PulseRuleSpec) => void;
}) {
  const { t } = useTranslation('panels');
  const managedAgents = useManagedAgentOptions(undefined, true);
  const agentChoices = useMemo(() => {
    if (managedAgents.length > 0) {
      return managedAgents.map((item) => ({
        value: item.value,
        label: item.label,
      }));
    }
    return [...FALLBACK_AGENTS];
  }, [managedAgents]);

  const currentTarget: PulseTargetSpec = spec.targets[0] ?? {
    kind: 'session',
    mode: 'thread_keyed',
    agentId: agentChoices[0]?.value ?? 'claude-code',
    workspaceIsolation: 'isolated_worktree',
    subscribeThread: true,
    promptTemplate:
      'Analyze {{event.eventType}} ({{payload.workflow_run.name}}) and propose a fix.',
  };

  const setTarget = (nextTarget: PulseTargetSpec) => {
    onChange({ ...spec, targets: [nextTarget] });
  };

  const switchTargetKind = (kind: 'session' | 'bot' | 'group' | 'user') => {
    if (currentTarget.kind === kind) return;
    const existingPrompt =
      currentTarget.kind === 'session' || currentTarget.kind === 'bot'
        ? currentTarget.promptTemplate
        : currentTarget.kind === 'group'
          ? currentTarget.messageTemplate
          : currentTarget.kind === 'user'
            ? currentTarget.bodyTemplate
            : '';

    if (kind === 'session') {
      setTarget({
        kind: 'session',
        mode: 'thread_keyed',
        agentId: agentChoices[0]?.value ?? 'claude-code',
        workspaceIsolation: 'isolated_worktree',
        subscribeThread: true,
        promptTemplate:
          existingPrompt ||
          'Analyze {{event.eventType}} ({{payload.workflow_run.name}}) and propose a fix.',
      });
    } else if (kind === 'bot') {
      setTarget({
        kind: 'bot',
        memberId: 'triage-bot',
        conversationScope: 'per_thread_topic',
        mailboxPolicy: 'fifo_serial',
        subscribeThread: true,
        promptTemplate:
          existingPrompt || 'Triage {{event.eventType}}: {{payload.text}}',
      });
    } else if (kind === 'group') {
      setTarget({
        kind: 'group',
        spaceId: 'eng-council',
        dispatchMode: {
          type: 'moderator_triage',
          moderatorMemberId: 'lead-bot',
        },
        messageTemplate:
          existingPrompt || 'Discuss {{event.eventType}}: {{payload.text}}',
      });
    } else {
      setTarget({
        kind: 'user',
        interactionKind: 'approval',
        severity: 'warning',
        titleTemplate: spec.name || 'Automation Review',
        bodyTemplate: existingPrompt || '{{payload.text}}',
      });
    }
  };

  const appendVariableToPrompt = (variableToken: string) => {
    if (currentTarget.kind === 'session') {
      setTarget({
        ...currentTarget,
        promptTemplate: `${currentTarget.promptTemplate}${currentTarget.promptTemplate.endsWith(' ') || !currentTarget.promptTemplate ? '' : ' '}${variableToken}`,
      });
    } else if (currentTarget.kind === 'bot') {
      setTarget({
        ...currentTarget,
        promptTemplate: `${currentTarget.promptTemplate}${currentTarget.promptTemplate.endsWith(' ') || !currentTarget.promptTemplate ? '' : ' '}${variableToken}`,
      });
    } else if (currentTarget.kind === 'group') {
      setTarget({
        ...currentTarget,
        messageTemplate: `${currentTarget.messageTemplate}${currentTarget.messageTemplate.endsWith(' ') || !currentTarget.messageTemplate ? '' : ' '}${variableToken}`,
      });
    } else if (currentTarget.kind === 'user') {
      setTarget({
        ...currentTarget,
        bodyTemplate: `${currentTarget.bodyTemplate}${currentTarget.bodyTemplate.endsWith(' ') || !currentTarget.bodyTemplate ? '' : ' '}${variableToken}`,
      });
    }
  };

  const kindOptions = [
    {
      id: 'session' as const,
      label: t('pulseDeck.workbench.editor.target.kindSession'),
      icon: Bot,
    },
    {
      id: 'bot' as const,
      label: t('pulseDeck.workbench.editor.target.kindBot'),
      icon: Bot,
    },
    {
      id: 'group' as const,
      label: t('pulseDeck.workbench.editor.target.kindGroup'),
      icon: Users,
    },
    {
      id: 'user' as const,
      label: t('pulseDeck.workbench.editor.target.kindUser'),
      icon: MessageSquare,
    },
  ];

  return (
    <div className="space-y-4" data-testid="fasttask-target-editor">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {kindOptions.map((item) => {
          const Icon = item.icon;
          const active = currentTarget.kind === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`fasttask-target-kind-${item.id}`}
              aria-pressed={active}
              onClick={() => switchTargetKind(item.id)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {currentTarget.kind === 'session' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="fasttask-session-agent" className="text-xs">
              {t('pulseDeck.workbench.editor.target.agentLabel')}
            </Label>
            <select
              id="fasttask-session-agent"
              data-testid="fasttask-session-agent"
              value={currentTarget.agentId}
              onChange={(e) =>
                setTarget({ ...currentTarget, agentId: e.target.value })
              }
              className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
            >
              {agentChoices.map((agent) => (
                <option key={agent.value} value={agent.value}>
                  {agent.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fasttask-session-isolation" className="text-xs">
              {t('pulseDeck.workbench.editor.target.isolationLabel')}
            </Label>
            <select
              id="fasttask-session-isolation"
              value={currentTarget.workspaceIsolation ?? 'isolated_worktree'}
              onChange={(e) =>
                setTarget({
                  ...currentTarget,
                  workspaceIsolation: e.target
                    .value as PulseWorkspaceIsolation,
                })
              }
              className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
            >
              <option value="isolated_worktree">
                {t('pulseDeck.workbench.editor.target.isolationWorktree')}
              </option>
              <option value="project_root">
                {t('pulseDeck.workbench.editor.target.isolationProject')}
              </option>
              <option value="scratch">
                {t('pulseDeck.workbench.editor.target.isolationScratch')}
              </option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fasttask-session-mode" className="text-xs">
              {t('pulseDeck.workbench.editor.target.sessionModeLabel')}
            </Label>
            <select
              id="fasttask-session-mode"
              value={currentTarget.mode}
              onChange={(e) =>
                setTarget({
                  ...currentTarget,
                  mode: e.target.value as SessionTargetMode,
                })
              }
              className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
            >
              <option value="thread_keyed">
                {t('pulseDeck.workbench.editor.target.sessionThreadKeyed')}
              </option>
              <option value="ephemeral_fresh">
                {t('pulseDeck.workbench.editor.target.sessionEphemeral')}
              </option>
            </select>
          </div>
        </div>
      ) : null}

      {currentTarget.kind === 'bot' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fasttask-bot-member" className="text-xs">
              {t('pulseDeck.workbench.editor.target.botMemberLabel')}
            </Label>
            <div className="flex gap-1.5">
              <select
                aria-label={t('pulseDeck.workbench.editor.target.botMemberLabel')}
                value={
                  ['triage-bot', 'release-bot', 'oncall-bot'].includes(
                    currentTarget.memberId
                  )
                    ? currentTarget.memberId
                    : 'triage-bot'
                }
                onChange={(e) =>
                  setTarget({ ...currentTarget, memberId: e.target.value })
                }
                className="h-8 rounded-md border border-border bg-[var(--surface-control)] px-2 text-xs text-foreground"
              >
                <option value="triage-bot">
                  {t('pulseDeck.workbench.editor.target.botPresetTriage')}
                </option>
                <option value="release-bot">
                  {t('pulseDeck.workbench.editor.target.botPresetRelease')}
                </option>
                <option value="oncall-bot">
                  {t('pulseDeck.workbench.editor.target.botPresetOncall')}
                </option>
              </select>
              <Input
                id="fasttask-bot-member"
                value={currentTarget.memberId}
                onChange={(e) =>
                  setTarget({ ...currentTarget, memberId: e.target.value })
                }
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fasttask-bot-mailbox" className="text-xs">
              {t('pulseDeck.workbench.editor.target.mailboxLabel')}
            </Label>
            <select
              id="fasttask-bot-mailbox"
              value={currentTarget.mailboxPolicy ?? 'fifo_serial'}
              onChange={(e) =>
                setTarget({
                  ...currentTarget,
                  mailboxPolicy: e.target.value as BotMailboxPolicy,
                })
              }
              className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
            >
              <option value="fifo_serial">
                {t('pulseDeck.workbench.editor.target.mailboxSerial')}
              </option>
              <option value="coalesce_batch">
                {t('pulseDeck.workbench.editor.target.mailboxCoalesce')}
              </option>
            </select>
          </div>
        </div>
      ) : null}

      {currentTarget.kind === 'group' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="fasttask-group-space" className="text-xs">
              {t('pulseDeck.workbench.editor.target.groupSpaceLabel')}
            </Label>
            <Input
              id="fasttask-group-space"
              value={currentTarget.spaceId}
              onChange={(e) =>
                setTarget({ ...currentTarget, spaceId: e.target.value })
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fasttask-group-dispatch" className="text-xs">
              {t('pulseDeck.workbench.editor.target.groupDispatchLabel')}
            </Label>
            <select
              id="fasttask-group-dispatch"
              value={currentTarget.dispatchMode.type}
              onChange={(e) =>
                setTarget({
                  ...currentTarget,
                  dispatchMode:
                    e.target.value === 'broadcast_log_only'
                      ? { type: 'broadcast_log_only' }
                      : {
                          type: 'moderator_triage',
                          moderatorMemberId: 'lead-bot',
                        },
                })
              }
              className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
            >
              <option value="moderator_triage">
                {t('pulseDeck.workbench.editor.target.groupModerator')}
              </option>
              <option value="broadcast_log_only">
                {t('pulseDeck.workbench.editor.target.groupBroadcast')}
              </option>
            </select>
          </div>
          {currentTarget.dispatchMode.type === 'moderator_triage' ? (
            <div className="space-y-1.5">
              <Label htmlFor="fasttask-group-mod" className="text-xs">
                {t('pulseDeck.workbench.editor.target.groupMemberLabel')}
              </Label>
              <Input
                id="fasttask-group-mod"
                value={currentTarget.dispatchMode.moderatorMemberId}
                onChange={(e) =>
                  setTarget({
                    ...currentTarget,
                    dispatchMode: {
                      type: 'moderator_triage',
                      moderatorMemberId: e.target.value,
                    },
                  })
                }
                className="h-8 text-xs"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {currentTarget.kind === 'user' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fasttask-user-kind" className="text-xs">
              {t('pulseDeck.workbench.editor.target.userKindLabel')}
            </Label>
            <select
              id="fasttask-user-kind"
              value={currentTarget.interactionKind}
              onChange={(e) =>
                setTarget({
                  ...currentTarget,
                  interactionKind: e.target.value as UserInteractionKind,
                })
              }
              className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs text-foreground"
            >
              <option value="approval">
                {t('pulseDeck.workbench.editor.target.userApproval')}
              </option>
              <option value="notify">
                {t('pulseDeck.workbench.editor.target.userNotify')}
              </option>
              <option value="ask_form">
                {t('pulseDeck.workbench.editor.target.userForm')}
              </option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fasttask-user-title" className="text-xs">
              {t('pulseDeck.workbench.editor.target.userTitleLabel')}
            </Label>
            <Input
              id="fasttask-user-title"
              value={currentTarget.titleTemplate}
              onChange={(e) =>
                setTarget({ ...currentTarget, titleTemplate: e.target.value })
              }
              className="h-8 text-xs"
            />
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="fasttask-prompt-template" className="text-xs">
          {t('pulseDeck.workbench.editor.target.promptLabel')}
        </Label>
        <Textarea
          id="fasttask-prompt-template"
          data-testid="fasttask-prompt-template"
          rows={4}
          value={
            currentTarget.kind === 'session' || currentTarget.kind === 'bot'
              ? currentTarget.promptTemplate
              : currentTarget.kind === 'group'
                ? currentTarget.messageTemplate
                : currentTarget.kind === 'user'
                  ? currentTarget.bodyTemplate
                  : ''
          }
          onChange={(e) => {
            const val = e.target.value;
            if (currentTarget.kind === 'session') {
              setTarget({ ...currentTarget, promptTemplate: val });
            } else if (currentTarget.kind === 'bot') {
              setTarget({ ...currentTarget, promptTemplate: val });
            } else if (currentTarget.kind === 'group') {
              setTarget({ ...currentTarget, messageTemplate: val });
            } else if (currentTarget.kind === 'user') {
              setTarget({ ...currentTarget, bodyTemplate: val });
            }
          }}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-2xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.target.variablesLabel')}
          </span>
          {PROMPT_VARIABLE_PILLS.map((pill) => (
            <button
              key={pill}
              type="button"
              data-testid={`fasttask-var-${pill}`}
              onClick={() => appendVariableToPrompt(pill)}
              className="rounded border border-border bg-[var(--surface-control)] px-1.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {pill}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FastTaskCallbackEditor({
  spec,
  onChange,
}: {
  spec: PulseRuleSpec;
  onChange: (next: PulseRuleSpec) => void;
}) {
  const { t } = useTranslation('panels');
  const [headersRaw, setHeadersRaw] = useState(() =>
    spec.callback?.headers
      ? JSON.stringify(spec.callback.headers, null, 2)
      : ''
  );
  const [previewText, setPreviewText] = useState<string | null>(null);

  const callback: PulseCallbackSpec = spec.callback ?? {
    kind: 'feishu_webhook',
    destination: '',
    payloadTemplate:
      '[{{event.eventType}}] {{payload.workflow_run.name}} -> {{payload.workflow_run.html_url}}',
    enabled: false,
  };
  const enabled = Boolean(spec.callback && spec.callback.enabled !== false);

  const updateCallback = (patch: Partial<PulseCallbackSpec>) => {
    onChange({
      ...spec,
      callback: {
        ...callback,
        enabled: true,
        ...patch,
      },
    });
  };

  const presetCards: Array<{
    kind: PulseCallbackKind;
    title: string;
    desc: string;
    placeholder: string;
  }> = [
    {
      kind: 'feishu_webhook',
      title: t('pulseDeck.workbench.editor.callback.feishuTitle'),
      desc: t('pulseDeck.workbench.editor.callback.feishuDesc'),
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
    },
    {
      kind: 'github_comment',
      title: t('pulseDeck.workbench.editor.callback.githubTitle'),
      desc: t('pulseDeck.workbench.editor.callback.githubDesc'),
      placeholder: 'owner/repo#123',
    },
    {
      kind: 'webhook_post',
      title: t('pulseDeck.workbench.editor.callback.webhookTitle'),
      desc: t('pulseDeck.workbench.editor.callback.webhookDesc'),
      placeholder: 'https://hooks.example.com/automation',
    },
    {
      kind: 'reply_channel',
      title: t('pulseDeck.workbench.editor.callback.replyTitle'),
      desc: t('pulseDeck.workbench.editor.callback.replyDesc'),
      placeholder: '{{threadKey}}',
    },
  ];

  const activePreset =
    presetCards.find((item) => item.kind === callback.kind) ?? presetCards[0]!;

  return (
    <div className="space-y-4" data-testid="fasttask-callback-editor">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <div className="text-xs font-medium text-foreground">
            {t('pulseDeck.workbench.editor.callback.enableLabel')}
          </div>
          <p className="text-2xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.callback.enableDesc')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          data-testid="fasttask-callback-switch"
          aria-checked={enabled}
          aria-label={t('pulseDeck.workbench.editor.callback.enableLabel')}
          onClick={() =>
            onChange({
              ...spec,
              callback: enabled
                ? { ...callback, enabled: false }
                : { ...callback, enabled: true },
            })
          }
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
            enabled
              ? 'border-primary bg-primary'
              : 'border-border bg-[var(--surface-control)]'
          )}
        >
          <span
            className={cn(
              'inline-block h-3.5 w-3.5 rounded-full bg-background transition-transform',
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            )}
          />
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {presetCards.map((card) => {
          const selected = enabled && callback.kind === card.kind;
          return (
            <button
              key={card.kind}
              type="button"
              data-testid={`fasttask-callback-kind-${card.kind}`}
              onClick={() =>
                updateCallback({
                  kind: card.kind,
                  destination:
                    card.kind === 'reply_channel'
                      ? '{{threadKey}}'
                      : callback.destination,
                })
              }
              className={cn(
                'flex flex-col items-start gap-1 rounded-md border p-2.5 text-left transition-colors',
                selected
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Send className="h-3 w-3 shrink-0" />
                {card.title}
              </span>
              <span className="text-2xs text-muted-foreground">{card.desc}</span>
            </button>
          );
        })}
      </div>

      {enabled ? (
        <div className="space-y-3">
          {callback.kind !== 'reply_channel' ? (
            <div className="space-y-1.5">
              <Label htmlFor="fasttask-callback-dest" className="text-xs">
                {t('pulseDeck.workbench.editor.callback.destinationLabel')}
              </Label>
              <Input
                id="fasttask-callback-dest"
                data-testid="fasttask-callback-destination"
                placeholder={activePreset.placeholder}
                value={callback.destination}
                onChange={(e) =>
                  updateCallback({ destination: e.target.value })
                }
                className="h-8 font-mono text-xs"
              />
            </div>
          ) : null}

          {callback.kind === 'webhook_post' ? (
            <div className="space-y-1.5">
              <Label htmlFor="fasttask-callback-headers" className="text-xs">
                {t('pulseDeck.workbench.editor.callback.headersLabel')}
              </Label>
              <Textarea
                id="fasttask-callback-headers"
                rows={2}
                placeholder='{"Authorization": "Bearer ..."}'
                value={headersRaw}
                onChange={(e) => {
                  const raw = e.target.value;
                  setHeadersRaw(raw);
                  try {
                    const parsed = raw.trim()
                      ? (JSON.parse(raw) as Record<string, string>)
                      : undefined;
                    updateCallback({ headers: parsed });
                  } catch {
                    // Keep editing draft until valid JSON
                  }
                }}
                className="font-mono text-xs"
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="fasttask-callback-template" className="text-xs">
              {t('pulseDeck.workbench.editor.callback.templateLabel')}
            </Label>
            <Textarea
              id="fasttask-callback-template"
              rows={3}
              value={callback.payloadTemplate ?? ''}
              onChange={(e) =>
                updateCallback({ payloadTemplate: e.target.value })
              }
              className="font-mono text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="fasttask-callback-preview-btn"
              onClick={() => {
                const sample = buildSampleEnvelopeForRule(spec);
                const rendered = renderTemplatePreview(
                  callback.payloadTemplate || '{{event.eventType}}',
                  sample
                );
                setPreviewText(
                  JSON.stringify(
                    {
                      kind: callback.kind,
                      destination:
                        callback.destination || activePreset.placeholder,
                      body: rendered,
                    },
                    null,
                    2
                  )
                );
              }}
            >
              <Webhook className="mr-1.5 h-3.5 w-3.5" />
              {t('pulseDeck.workbench.editor.callback.previewBtn')}
            </Button>
          </div>

          {previewText ? (
            <div
              data-testid="fasttask-callback-preview-output"
              className="rounded-md border border-border bg-[var(--surface-panel)] p-2.5"
            >
              <div className="mb-1 flex items-center gap-1.5 text-2xs font-medium text-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {t('pulseDeck.workbench.editor.callback.previewTitle')}
              </div>
              <pre className="overflow-x-auto font-mono text-2xs text-muted-foreground">
                {previewText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FastTaskRecordsPane({
  rule,
  capturedEvents,
  recentOutbox,
}: {
  rule: PulseRuleView | null;
  capturedEvents: readonly EventEnvelope[];
  recentOutbox: readonly PulseOutboxEntryView[];
}) {
  const { t } = useTranslation('panels');

  const matchingEvents = useMemo(() => {
    if (!rule) return [];
    const allowedKinds = rule.spec.filter.sourceKinds;
    const allowedTypes = rule.spec.filter.eventTypes;
    return capturedEvents
      .filter((evt) => {
        const kindOk =
          allowedKinds.length === 0 || allowedKinds.includes(evt.source.kind);
        const typeOk =
          allowedTypes.length === 0 || allowedTypes.includes(evt.eventType);
        return kindOk && typeOk;
      })
      .slice(0, 8);
  }, [capturedEvents, rule]);

  const matchingOutbox = useMemo(() => {
    if (!rule) return [];
    return recentOutbox.filter(
      (entry) => !entry.ruleId || entry.ruleId === rule.id
    );
  }, [recentOutbox, rule]);

  const lastTestedAt = rule?.spec.taskMeta?.lastTestedAt ?? null;
  const lastRunAt = rule?.spec.taskMeta?.lastRunAt ?? null;

  return (
    <div className="space-y-4" data-testid="fasttask-records-pane">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md border border-border bg-[var(--surface-panel)] px-3 py-2">
          <div className="text-2xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.records.matchedStat')}
          </div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {rule?.matchedCount ?? 0}
          </div>
        </div>
        <div className="rounded-md border border-border bg-[var(--surface-panel)] px-3 py-2">
          <div className="text-2xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.records.observedStat')}
          </div>
          <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {rule?.observedCount ?? 0}
          </div>
        </div>
        <div className="rounded-md border border-border bg-[var(--surface-panel)] px-3 py-2">
          <div className="text-2xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.records.lastTestedStat')}
          </div>
          <div className="mt-0.5 truncate text-xs font-medium tabular-nums text-foreground">
            {lastTestedAt
              ? lastTestedAt.slice(0, 19).replace('T', ' ')
              : t('pulseDeck.workbench.editor.records.never')}
          </div>
        </div>
        <div className="rounded-md border border-border bg-[var(--surface-panel)] px-3 py-2">
          <div className="text-2xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.records.lastRunStat')}
          </div>
          <div className="mt-0.5 truncate text-xs font-medium tabular-nums text-foreground">
            {lastRunAt
              ? lastRunAt.slice(0, 19).replace('T', ' ')
              : t('pulseDeck.workbench.editor.records.never')}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-foreground">
          {t('pulseDeck.workbench.editor.records.capturedTitle')}
        </h4>
        {matchingEvents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.records.capturedEmpty')}
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border bg-[var(--surface-panel)]">
            {matchingEvents.map((evt) => (
              <div
                key={evt.eventId}
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-foreground">
                    {evt.eventType}
                  </div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {evt.threadKey ?? evt.source.instanceId}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                  {evt.occurredAt.slice(0, 19).replace('T', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-foreground">
          {t('pulseDeck.workbench.editor.records.outboxTitle')}
        </h4>
        {matchingOutbox.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('pulseDeck.workbench.editor.records.outboxEmpty')}
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border bg-[var(--surface-panel)]">
            {matchingOutbox.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">
                    {entry.targetKind} · {entry.destination ?? '-'}
                  </div>
                  {entry.lastError ? (
                    <div className="truncate text-2xs text-destructive">
                      {entry.lastError}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-muted-foreground">
                  <span>{entry.status}</span>
                  <span>
                    {t('pulseDeck.workbench.editor.records.attemptsCount', {
                      count: entry.attempts,
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
