import { Bot, Terminal } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PulseEvalModeControl,
  formatEventSourceLabel,
  formatMailboxPolicyLabel,
} from '@/features/pulse';
import type {
  BotConversationScope,
  BotMailboxPolicy,
  EventSourceKind,
  GroupDispatchMode,
  PulseTemporalSpec,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import type {
  ControlNodeKind,
  OutboxActionKind,
  StudioWorkflowStep,
  TriggerKind,
  UserGateInteractionKind,
} from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowStudioInspectorAgent } from './WorkflowStudioInspectorAgent';
import {
  formatOutboxActionLabel,
  switchExecutionPrimitive,
} from './workflowStepPresentation';

const SOURCE_OPTIONS: readonly EventSourceKind[] = [
  'github',
  'feishu',
  'jira',
  'webhook_standard',
  'webhook_custom',
  'sdk_custom',
  'system_internal',
];

function createDefaultTemporalSpec(
  kind: PulseTemporalSpec['kind']
): PulseTemporalSpec {
  switch (kind) {
    case 'cron':
      return {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'UTC',
        weekdaysOnly: true,
      };
    case 'once':
      return {
        kind: 'once',
        fireAt: '2026-11-16T09:00:00Z',
      };
    case 'interval':
      return {
        kind: 'interval',
        everySeconds: 300,
      };
    case 'inactivity_sla':
      return {
        kind: 'inactivity_sla',
        threadKeyPrefix: 'github:pr:',
        timeoutSeconds: 1800,
      };
  }
}

export function WorkflowStudioInspectorVisual({
  selectedStep,
  studio,
}: {
  selectedStep: StudioWorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    onDefinitionChange,
    updateStep,
    updateJson,
    definition,
    latest,
    defaultAgentId,
    outputLanguage,
  } = studio;

  const isExecutionPrimitive =
    selectedStep.kind === 'session' ||
    selectedStep.kind === 'agent' ||
    selectedStep.kind === 'bot';

  return (
    <div className="space-y-4">
      {isExecutionPrimitive ? (
        <div className="space-y-1.5">
          <Label>Execution Primitive</Label>
          <div
            role="radiogroup"
            aria-label="Execution Primitive"
            className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/65 p-0.5"
          >
            {(
              [
                {
                  id: 'session',
                  label: 'Fresh Session',
                  sub: 'Resets Per Run',
                  icon: Terminal,
                },
                {
                  id: 'bot',
                  label: 'Persistent Bot',
                  sub: 'Fixed Memory',
                  icon: Bot,
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active =
                item.id === 'bot'
                  ? selectedStep.kind === 'bot'
                  : selectedStep.kind === 'session' ||
                    selectedStep.kind === 'agent';
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!onDefinitionChange}
                  data-testid={`inspector-primitive-${item.id}`}
                  onClick={() =>
                    updateStep(selectedStep.id, (step) =>
                      switchExecutionPrimitive(
                        step,
                        item.id,
                        defaultAgentId,
                        outputLanguage
                      )
                    )
                  }
                  className={cn(
                    'flex flex-col items-start rounded-md px-2.5 py-1.5 text-left transition-colors disabled:opacity-60',
                    active
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs font-semibold">
                    <Icon className="size-3.5" />
                    {item.label}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {item.sub}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {selectedStep.kind === 'agent' || selectedStep.kind === 'session' ? (
        <WorkflowStudioInspectorAgent
          selectedStep={selectedStep}
          studio={studio}
        />
      ) : selectedStep.kind === 'bot' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-bot-member">Bound Bot (memberId)</Label>
            <Input
              id="workflow-bot-member"
              value={selectedStep.memberId}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'bot'
                    ? { ...step, memberId: event.target.value }
                    : step
                )
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label>Conversation Scope</Label>
              <Select
                value={selectedStep.conversationScope}
                disabled={!onDefinitionChange}
                onValueChange={(conversationScope: BotConversationScope) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'bot' ? { ...step, conversationScope } : step
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed_primary">Fixed Primary</SelectItem>
                  <SelectItem value="per_thread_topic">
                    Per-Thread Topic
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Mailbox Policy</Label>
              <Select
                value={selectedStep.mailboxPolicy}
                disabled={!onDefinitionChange}
                onValueChange={(mailboxPolicy: BotMailboxPolicy) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'bot' ? { ...step, mailboxPolicy } : step
                  )
                }
              >
                <SelectTrigger data-testid="inspector-bot-mailbox">
                  <SelectValue>
                    {formatMailboxPolicyLabel(selectedStep.mailboxPolicy)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fifo_serial">FIFO Serial</SelectItem>
                  <SelectItem value="coalesce_batch">Coalesce Batch</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-bot-prompt">{t('studio.prompt')}</Label>
            <textarea
              id="workflow-bot-prompt"
              value={selectedStep.prompt}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'bot'
                    ? { ...step, prompt: event.target.value }
                    : step
                )
              }
              className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
            />
          </div>
        </>
      ) : selectedStep.kind === 'trigger' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-trigger-title">{t('studio.title')}</Label>
            <Input
              id="workflow-trigger-title"
              value={selectedStep.title}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'trigger'
                    ? { ...step, title: event.target.value }
                    : step
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Evaluation Mode</Label>
            <div>
              <PulseEvalModeControl
                value={selectedStep.evalMode}
                disabled={!onDefinitionChange}
                onChange={(evalMode) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'trigger' ? { ...step, evalMode } : step
                  )
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Trigger Category</Label>
            <Select
              value={selectedStep.triggerKind}
              disabled={!onDefinitionChange}
              onValueChange={(triggerKind: TriggerKind) =>
                updateStep(selectedStep.id, (step) => {
                  if (step.kind !== 'trigger') return step;
                  if (triggerKind === 'temporal') {
                    return {
                      ...step,
                      triggerKind,
                      sourceKind: 'time_cron',
                      eventType: 'time.cron.tick',
                      temporal:
                        step.temporal ?? createDefaultTemporalSpec('cron'),
                    };
                  }
                  return {
                    ...step,
                    triggerKind,
                    sourceKind:
                      triggerKind === 'webhook'
                        ? 'webhook_standard'
                        : triggerKind === 'sdk'
                          ? 'sdk_custom'
                          : 'github',
                    temporal: null,
                  };
                })
              }
            >
              <SelectTrigger data-testid="inspector-trigger-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="platform">Platform Event</SelectItem>
                <SelectItem value="webhook">Webhook</SelectItem>
                <SelectItem value="temporal">
                  Temporal (Cron / Once / Interval / SLA)
                </SelectItem>
                <SelectItem value="sdk">Custom SDK</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedStep.triggerKind === 'temporal' ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-2.5">
              <div className="space-y-1.5">
                <Label>Temporal Schedule Kind</Label>
                <Select
                  value={selectedStep.temporal?.kind ?? 'cron'}
                  disabled={!onDefinitionChange}
                  onValueChange={(kind: PulseTemporalSpec['kind']) =>
                    updateStep(selectedStep.id, (step) => {
                      if (step.kind !== 'trigger') return step;
                      const sourceMap = {
                        cron: 'time_cron',
                        once: 'time_once',
                        interval: 'time_interval',
                        inactivity_sla: 'time_sla',
                      } as const;
                      return {
                        ...step,
                        sourceKind: sourceMap[kind],
                        temporal: createDefaultTemporalSpec(kind),
                      };
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cron">Cron Schedule</SelectItem>
                    <SelectItem value="once">Fire Once</SelectItem>
                    <SelectItem value="interval">Fixed Interval</SelectItem>
                    <SelectItem value="inactivity_sla">
                      Inactivity SLA
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {selectedStep.temporal?.kind === 'cron' ? (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="temporal-cron-expr">Cron Expression</Label>
                    <Input
                      id="temporal-cron-expr"
                      className="font-mono text-xs"
                      value={selectedStep.temporal.expression}
                      disabled={!onDefinitionChange}
                      onChange={(event) =>
                        updateStep(selectedStep.id, (step) =>
                          step.kind === 'trigger' &&
                          step.temporal?.kind === 'cron'
                            ? {
                                ...step,
                                temporal: {
                                  ...step.temporal,
                                  expression: event.target.value,
                                },
                              }
                            : step
                        )
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="temporal-cron-tz">Timezone</Label>
                    <Input
                      id="temporal-cron-tz"
                      value={selectedStep.temporal.timezone}
                      disabled={!onDefinitionChange}
                      onChange={(event) =>
                        updateStep(selectedStep.id, (step) =>
                          step.kind === 'trigger' &&
                          step.temporal?.kind === 'cron'
                            ? {
                                ...step,
                                temporal: {
                                  ...step.temporal,
                                  timezone: event.target.value,
                                },
                              }
                            : step
                        )
                      }
                    />
                  </div>
                </div>
              ) : selectedStep.temporal?.kind === 'once' ? (
                <div className="space-y-1">
                  <Label htmlFor="temporal-once-fire">Fire At (ISO-8601)</Label>
                  <Input
                    id="temporal-once-fire"
                    className="font-mono text-xs tabular-nums"
                    value={selectedStep.temporal.fireAt}
                    disabled={!onDefinitionChange}
                    onChange={(event) =>
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'trigger' &&
                        step.temporal?.kind === 'once'
                          ? {
                              ...step,
                              temporal: {
                                ...step.temporal,
                                fireAt: event.target.value,
                              },
                            }
                          : step
                      )
                    }
                  />
                </div>
              ) : selectedStep.temporal?.kind === 'interval' ? (
                <div className="space-y-1">
                  <Label htmlFor="temporal-interval-sec">
                    Interval (seconds)
                  </Label>
                  <Input
                    id="temporal-interval-sec"
                    type="number"
                    className="tabular-nums"
                    value={selectedStep.temporal.everySeconds}
                    disabled={!onDefinitionChange}
                    onChange={(event) =>
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'trigger' &&
                        step.temporal?.kind === 'interval'
                          ? {
                              ...step,
                              temporal: {
                                ...step.temporal,
                                everySeconds: Number(event.target.value || 0),
                              },
                            }
                          : step
                      )
                    }
                  />
                </div>
              ) : selectedStep.temporal?.kind === 'inactivity_sla' ? (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="temporal-sla-prefix">
                      Thread Key Prefix
                    </Label>
                    <Input
                      id="temporal-sla-prefix"
                      className="font-mono text-xs"
                      value={selectedStep.temporal.threadKeyPrefix}
                      disabled={!onDefinitionChange}
                      onChange={(event) =>
                        updateStep(selectedStep.id, (step) =>
                          step.kind === 'trigger' &&
                          step.temporal?.kind === 'inactivity_sla'
                            ? {
                                ...step,
                                temporal: {
                                  ...step.temporal,
                                  threadKeyPrefix: event.target.value,
                                },
                              }
                            : step
                        )
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="temporal-sla-sec">Timeout (seconds)</Label>
                    <Input
                      id="temporal-sla-sec"
                      type="number"
                      className="tabular-nums"
                      value={selectedStep.temporal.timeoutSeconds}
                      disabled={!onDefinitionChange}
                      onChange={(event) =>
                        updateStep(selectedStep.id, (step) =>
                          step.kind === 'trigger' &&
                          step.temporal?.kind === 'inactivity_sla'
                            ? {
                                ...step,
                                temporal: {
                                  ...step.temporal,
                                  timeoutSeconds: Number(
                                    event.target.value || 0
                                  ),
                                },
                              }
                            : step
                        )
                      }
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label>Event Source</Label>
                <Select
                  value={selectedStep.sourceKind}
                  disabled={!onDefinitionChange}
                  onValueChange={(sourceKind: EventSourceKind) =>
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'trigger'
                        ? {
                            ...step,
                            sourceKind,
                            filter: {
                              ...step.filter,
                              sourceKinds: [sourceKind],
                            },
                          }
                        : step
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {formatEventSourceLabel(selectedStep.sourceKind)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_OPTIONS.map((source) => (
                      <SelectItem key={source} value={source}>
                        {formatEventSourceLabel(source)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-trigger-event-type">Event Type</Label>
                <Input
                  id="workflow-trigger-event-type"
                  className="font-mono text-xs"
                  value={selectedStep.eventType}
                  disabled={!onDefinitionChange}
                  onChange={(event) =>
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'trigger'
                        ? {
                            ...step,
                            eventType: event.target.value,
                            filter: {
                              ...step.filter,
                              eventTypes: event.target.value.trim()
                                ? [event.target.value.trim()]
                                : [],
                            },
                          }
                        : step
                    )
                  }
                />
              </div>
            </div>
          )}
        </>
      ) : selectedStep.kind === 'group_stage' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-group-space">
              Collaboration Space ID
            </Label>
            <Input
              id="workflow-group-space"
              value={selectedStep.spaceId}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'group_stage'
                    ? { ...step, spaceId: event.target.value }
                    : step
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Dispatch Mode</Label>
            <Select
              value={selectedStep.dispatchMode.type}
              disabled={!onDefinitionChange}
              onValueChange={(modeType: GroupDispatchMode['type']) =>
                updateStep(selectedStep.id, (step) => {
                  if (step.kind !== 'group_stage') return step;
                  const dispatchMode: GroupDispatchMode =
                    modeType === 'specific_seat'
                      ? { type: 'specific_seat', memberId: 'lead-bot' }
                      : modeType === 'mention_seats'
                        ? {
                            type: 'mention_seats',
                            memberIds: ['pm-bot', 'qa-bot'],
                          }
                        : modeType === 'moderator_triage'
                          ? {
                              type: 'moderator_triage',
                              moderatorMemberId: 'moderator-bot',
                            }
                          : { type: 'broadcast_log_only' };
                  return { ...step, dispatchMode };
                })
              }
            >
              <SelectTrigger data-testid="inspector-group-dispatch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="specific_seat">Specific Seat</SelectItem>
                <SelectItem value="mention_seats">Mention Seats</SelectItem>
                <SelectItem value="moderator_triage">
                  Moderator Triage
                </SelectItem>
                <SelectItem value="broadcast_log_only">
                  Broadcast Log Only
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedStep.dispatchMode.type === 'specific_seat' ? (
            <div className="space-y-1.5">
              <Label htmlFor="workflow-group-seat">Seat Member ID</Label>
              <Input
                id="workflow-group-seat"
                value={selectedStep.dispatchMode.memberId}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'group_stage' &&
                    step.dispatchMode.type === 'specific_seat'
                      ? {
                          ...step,
                          dispatchMode: {
                            type: 'specific_seat',
                            memberId: event.target.value,
                          },
                        }
                      : step
                  )
                }
              />
            </div>
          ) : selectedStep.dispatchMode.type === 'mention_seats' ? (
            <div className="space-y-1.5">
              <Label htmlFor="workflow-group-mentions">
                Mentioned Seats (comma-separated)
              </Label>
              <Input
                id="workflow-group-mentions"
                value={selectedStep.dispatchMode.memberIds.join(', ')}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'group_stage' &&
                    step.dispatchMode.type === 'mention_seats'
                      ? {
                          ...step,
                          dispatchMode: {
                            type: 'mention_seats',
                            memberIds: event.target.value
                              .split(',')
                              .map((part) => part.trim())
                              .filter(Boolean),
                          },
                        }
                      : step
                  )
                }
              />
            </div>
          ) : selectedStep.dispatchMode.type === 'moderator_triage' ? (
            <div className="space-y-1.5">
              <Label htmlFor="workflow-group-moderator">
                Moderator Member ID
              </Label>
              <Input
                id="workflow-group-moderator"
                value={selectedStep.dispatchMode.moderatorMemberId}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'group_stage' &&
                    step.dispatchMode.type === 'moderator_triage'
                      ? {
                          ...step,
                          dispatchMode: {
                            type: 'moderator_triage',
                            moderatorMemberId: event.target.value,
                          },
                        }
                      : step
                  )
                }
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="workflow-group-prompt">{t('studio.prompt')}</Label>
            <textarea
              id="workflow-group-prompt"
              value={selectedStep.prompt}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'group_stage'
                    ? { ...step, prompt: event.target.value }
                    : step
                )
              }
              className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
            />
          </div>
        </>
      ) : selectedStep.kind === 'user_gate' ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label>Interaction Kind</Label>
              <Select
                value={selectedStep.interactionKind}
                disabled={!onDefinitionChange}
                onValueChange={(interactionKind: UserGateInteractionKind) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'user_gate'
                      ? { ...step, interactionKind }
                      : step
                  )
                }
              >
                <SelectTrigger data-testid="inspector-user-gate-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="notify">Notify</SelectItem>
                  <SelectItem value="approval">Approval</SelectItem>
                  <SelectItem value="ask_form">Ask Form</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workflow-gate-sla">SLA Timeout (s)</Label>
              <Input
                id="workflow-gate-sla"
                type="number"
                className="tabular-nums"
                value={selectedStep.slaTimeoutSeconds ?? ''}
                placeholder="Optional"
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'user_gate'
                      ? {
                          ...step,
                          slaTimeoutSeconds: event.target.value.trim()
                            ? Number(event.target.value)
                            : null,
                        }
                      : step
                  )
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-gate-title">{t('studio.title')}</Label>
            <Input
              id="workflow-gate-title"
              value={selectedStep.title}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'user_gate'
                    ? { ...step, title: event.target.value }
                    : step
                )
              }
            />
          </div>
          {selectedStep.interactionKind === 'approval' ? (
            <div className="space-y-1.5">
              <Label htmlFor="workflow-gate-scope">
                {t('studio.approverScope')}
              </Label>
              <Input
                id="workflow-gate-scope"
                value={selectedStep.approverScope ?? 'workspace_owner'}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'user_gate'
                      ? { ...step, approverScope: event.target.value }
                      : step
                  )
                }
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="workflow-gate-body">Message / Body Template</Label>
            <textarea
              id="workflow-gate-body"
              value={selectedStep.bodyTemplate}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'user_gate'
                    ? { ...step, bodyTemplate: event.target.value }
                    : step
                )
              }
              className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
            />
          </div>
        </>
      ) : selectedStep.kind === 'notify' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-notify-title">{t('studio.title')}</Label>
            <Input
              id="workflow-notify-title"
              value={selectedStep.title}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'notify'
                    ? {
                        ...step,
                        title: event.target.value,
                      }
                    : step
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('studio.notifyRecords')}</Label>
            <div className="space-y-2">
              {definition.steps
                .filter((step) => selectedStep.dependsOn.includes(step.id))
                .map((step) => {
                  const stepRun = latest.get(step.id);
                  return (
                    <details
                      key={step.id}
                      className="rounded-lg border bg-muted/20"
                      open
                    >
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                        {t('studio.notifyRecord', {
                          step: step.id,
                          time: stepRun?.completedAt
                            ? new Date(stepRun.completedAt).toLocaleString()
                            : t('studio.standby'),
                        })}
                      </summary>
                      <pre className="max-h-40 overflow-auto border-t p-3 text-[11px] leading-5">
                        {stepRun?.candidateOutputJson ??
                          stepRun?.outputJson ??
                          t('studio.noPreviewResult')}
                      </pre>
                    </details>
                  );
                })}
            </div>
          </div>
        </>
      ) : selectedStep.kind === 'approval' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-approval-title">{t('studio.title')}</Label>
            <Input
              id="workflow-approval-title"
              value={selectedStep.title}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'approval'
                    ? {
                        ...step,
                        title: event.target.value,
                      }
                    : step
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-approver-scope">
              {t('studio.approverScope')}
            </Label>
            <Input
              id="workflow-approver-scope"
              value={selectedStep.approverScope}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'approval'
                    ? {
                        ...step,
                        approverScope: event.target.value,
                      }
                    : step
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-decision-schema">
              {t('studio.decisionSchema')}
            </Label>
            <textarea
              id="workflow-decision-schema"
              key={`${selectedStep.id}-decision-schema`}
              defaultValue={JSON.stringify(
                selectedStep.decisionSchema,
                null,
                2
              )}
              disabled={!onDefinitionChange}
              onBlur={(event) =>
                updateJson(event.target.value, (decisionSchema) => {
                  if (decisionSchema)
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'approval'
                        ? {
                            ...step,
                            decisionSchema,
                          }
                        : step
                    );
                })
              }
              className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[11px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
            />
          </div>
        </>
      ) : selectedStep.kind === 'control' ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label>Control Type</Label>
              <Select
                value={selectedStep.controlKind}
                disabled={!onDefinitionChange}
                onValueChange={(controlKind: ControlNodeKind) =>
                  updateStep(selectedStep.id, (step) => {
                    if (step.kind !== 'control') return step;
                    if (controlKind === 'bounded_loop') {
                      return {
                        ...step,
                        controlKind,
                        maxIterations: step.maxIterations ?? 3,
                      };
                    }
                    if (controlKind === 'wait_for_event') {
                      return {
                        ...step,
                        controlKind,
                        waitEventType:
                          step.waitEventType ?? 'github.ci.completed',
                        threadKeyTemplate:
                          step.threadKeyTemplate ?? '{{threadKey}}',
                      };
                    }
                    return {
                      ...step,
                      controlKind,
                      expression: step.expression ?? 'output.approved == true',
                    };
                  })
                }
              >
                <SelectTrigger data-testid="inspector-control-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="condition">Condition / Switch</SelectItem>
                  <SelectItem value="bounded_loop">BoundedLoop</SelectItem>
                  <SelectItem value="wait_for_event">WaitForEvent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workflow-control-title">
                {t('studio.title')}
              </Label>
              <Input
                id="workflow-control-title"
                value={selectedStep.title}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'control'
                      ? { ...step, title: event.target.value }
                      : step
                  )
                }
              />
            </div>
          </div>

          {selectedStep.controlKind === 'bounded_loop' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1.5">
                  <Label htmlFor="workflow-loop-max">
                    Max Iterations (1-50)
                  </Label>
                  <Input
                    id="workflow-loop-max"
                    type="number"
                    min={1}
                    max={50}
                    data-testid="inspector-bounded-loop-max-iterations"
                    className="tabular-nums"
                    value={selectedStep.maxIterations ?? ''}
                    disabled={!onDefinitionChange}
                    onChange={(event) =>
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'control'
                          ? {
                              ...step,
                              maxIterations: Number(event.target.value),
                            }
                          : step
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="workflow-loop-target">
                    Loop Target Step ID
                  </Label>
                  <Input
                    id="workflow-loop-target"
                    className="font-mono text-xs"
                    value={selectedStep.loopTargetStepId ?? ''}
                    disabled={!onDefinitionChange}
                    onChange={(event) =>
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'control'
                          ? { ...step, loopTargetStepId: event.target.value }
                          : step
                      )
                    }
                  />
                </div>
              </div>
              {typeof selectedStep.maxIterations !== 'number' ||
              !Number.isInteger(selectedStep.maxIterations) ||
              selectedStep.maxIterations < 1 ||
              selectedStep.maxIterations > 50 ? (
                <p
                  role="alert"
                  data-testid="inspector-bounded-loop-error"
                  className="text-xs text-destructive"
                >
                  BoundedLoop maxIterations must be an integer between 1 and 50
                  (1 &lt;= maxIterations &lt;= 50).
                </p>
              ) : null}
            </div>
          ) : selectedStep.controlKind === 'wait_for_event' ? (
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label htmlFor="workflow-wait-event">
                  Correlated Event Type
                </Label>
                <Input
                  id="workflow-wait-event"
                  className="font-mono text-xs"
                  value={selectedStep.waitEventType ?? ''}
                  disabled={!onDefinitionChange}
                  onChange={(event) =>
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'control'
                        ? { ...step, waitEventType: event.target.value }
                        : step
                    )
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-wait-thread">
                  Thread Key Template
                </Label>
                <Input
                  id="workflow-wait-thread"
                  className="font-mono text-xs"
                  value={selectedStep.threadKeyTemplate ?? ''}
                  disabled={!onDefinitionChange}
                  onChange={(event) =>
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'control'
                        ? { ...step, threadKeyTemplate: event.target.value }
                        : step
                    )
                  }
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="workflow-condition-expr">Branch Expression</Label>
              <Input
                id="workflow-condition-expr"
                className="font-mono text-xs"
                value={selectedStep.expression ?? ''}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'control'
                      ? { ...step, expression: event.target.value }
                      : step
                  )
                }
              />
            </div>
          )}
        </>
      ) : selectedStep.kind === 'outbox_action' ? (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label>Outbox Target</Label>
              <Select
                value={selectedStep.actionKind}
                disabled={!onDefinitionChange}
                onValueChange={(actionKind: OutboxActionKind) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'outbox_action'
                      ? { ...step, actionKind }
                      : step
                  )
                }
              >
                <SelectTrigger data-testid="inspector-outbox-kind">
                  <SelectValue>
                    {formatOutboxActionLabel(selectedStep.actionKind)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="feishu_reply">Feishu Reply</SelectItem>
                  <SelectItem value="jira_comment">Jira Comment</SelectItem>
                  <SelectItem value="github_comment">GitHub Comment</SelectItem>
                  <SelectItem value="webhook_post">Webhook POST</SelectItem>
                  <SelectItem value="emit_event">Emit Event</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workflow-outbox-title">{t('studio.title')}</Label>
              <Input
                id="workflow-outbox-title"
                value={selectedStep.title}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'outbox_action'
                      ? { ...step, title: event.target.value }
                      : step
                  )
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-outbox-dest">
              Destination / Channel / URL
            </Label>
            <Input
              id="workflow-outbox-dest"
              className="font-mono text-xs"
              value={selectedStep.destination}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'outbox_action'
                    ? { ...step, destination: event.target.value }
                    : step
                )
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-outbox-payload">
              Idempotent Payload Template
            </Label>
            <textarea
              id="workflow-outbox-payload"
              value={selectedStep.payloadTemplate}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'outbox_action'
                    ? { ...step, payloadTemplate: event.target.value }
                    : step
                )
              }
              className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
