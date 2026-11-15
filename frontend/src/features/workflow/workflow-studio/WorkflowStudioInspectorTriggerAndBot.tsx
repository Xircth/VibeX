import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PulseEvalModeControl } from '@/features/pulse';
import type {
  BotConversationScope,
  BotMailboxPolicy,
  EventSourceKind,
  PulseTemporalSpec,
} from '@/lib/api/pulse';

import type { StudioWorkflowStep, TriggerKind } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import {
  formatWorkflowEventSource,
  formatWorkflowMailboxPolicy,
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

export function WorkflowStudioInspectorTriggerAndBot({
  selectedStep,
  studio,
}: {
  selectedStep: Extract<StudioWorkflowStep, { kind: 'bot' | 'trigger' }>;
  studio: WorkflowStudioView;
}) {
  const { t, onDefinitionChange, updateStep } = studio;

  if (selectedStep.kind === 'bot') {
    return (
      <>
        <div className="space-y-1.5">
          <Label htmlFor="workflow-bot-member">
            {t('inspector.bot.memberId')}
          </Label>
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
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('inspector.bot.memberIdHint')}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5">
            <Label>{t('inspector.bot.conversationScope')}</Label>
            <Select
              value={selectedStep.conversationScope}
              disabled={!onDefinitionChange}
              onValueChange={(conversationScope: BotConversationScope) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'bot' ? { ...step, conversationScope } : step
                )
              }
            >
              <SelectTrigger data-testid="inspector-bot-scope">
                <SelectValue>
                  {t(`inspector.bot.scopes.${selectedStep.conversationScope}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed_primary">
                  {t('inspector.bot.scopes.fixed_primary')}
                </SelectItem>
                <SelectItem value="per_thread_topic">
                  {t('inspector.bot.scopes.per_thread_topic')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('inspector.bot.mailboxPolicy')}</Label>
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
                  {formatWorkflowMailboxPolicy(selectedStep.mailboxPolicy, t)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fifo_serial">
                  {t('inspector.bot.mailboxOptions.fifo_serial')}
                </SelectItem>
                <SelectItem value="coalesce_batch">
                  {t('inspector.bot.mailboxOptions.coalesce_batch')}
                </SelectItem>
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
    );
  }

  return (
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
        <Label>{t('inspector.trigger.evalMode')}</Label>
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
        <Label>{t('inspector.trigger.category')}</Label>
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
                  temporal: step.temporal ?? createDefaultTemporalSpec('cron'),
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
            <SelectValue>
              {t(`inspector.trigger.categories.${selectedStep.triggerKind}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="platform">
              {t('inspector.trigger.categories.platform')}
            </SelectItem>
            <SelectItem value="webhook">
              {t('inspector.trigger.categories.webhook')}
            </SelectItem>
            <SelectItem value="temporal">
              {t('inspector.trigger.categories.temporal')}
            </SelectItem>
            <SelectItem value="sdk">
              {t('inspector.trigger.categories.sdk')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {selectedStep.triggerKind === 'temporal' ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/25 p-2.5">
          <div className="space-y-1.5">
            <Label>{t('inspector.trigger.temporalKind')}</Label>
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
                <SelectValue>
                  {t(
                    `inspector.trigger.temporalKinds.${selectedStep.temporal?.kind ?? 'cron'}`
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">
                  {t('inspector.trigger.temporalKinds.cron')}
                </SelectItem>
                <SelectItem value="once">
                  {t('inspector.trigger.temporalKinds.once')}
                </SelectItem>
                <SelectItem value="interval">
                  {t('inspector.trigger.temporalKinds.interval')}
                </SelectItem>
                <SelectItem value="inactivity_sla">
                  {t('inspector.trigger.temporalKinds.inactivity_sla')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedStep.temporal?.kind === 'cron' ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="temporal-cron-expr">
                  {t('inspector.trigger.cronExpression')}
                </Label>
                <Input
                  id="temporal-cron-expr"
                  className="font-mono text-xs"
                  value={selectedStep.temporal.expression}
                  disabled={!onDefinitionChange}
                  onChange={(event) =>
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'trigger' && step.temporal?.kind === 'cron'
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
                <Label htmlFor="temporal-cron-tz">
                  {t('inspector.trigger.timezone')}
                </Label>
                <Input
                  id="temporal-cron-tz"
                  value={selectedStep.temporal.timezone}
                  disabled={!onDefinitionChange}
                  onChange={(event) =>
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'trigger' && step.temporal?.kind === 'cron'
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
              <Label htmlFor="temporal-once-fire">
                {t('inspector.trigger.fireAt')}
              </Label>
              <Input
                id="temporal-once-fire"
                className="font-mono text-xs tabular-nums"
                value={selectedStep.temporal.fireAt}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'trigger' && step.temporal?.kind === 'once'
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
                {t('inspector.trigger.intervalSeconds')}
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
                  {t('inspector.trigger.threadKeyPrefix')}
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
                <Label htmlFor="temporal-sla-sec">
                  {t('inspector.trigger.timeoutSeconds')}
                </Label>
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
                              timeoutSeconds: Number(event.target.value || 0),
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
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label>{t('inspector.trigger.eventSource')}</Label>
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
                    {formatWorkflowEventSource(selectedStep.sourceKind, t)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map((source) => (
                    <SelectItem key={source} value={source}>
                      {formatWorkflowEventSource(source, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workflow-trigger-event-type">
                {t('inspector.trigger.eventType')}
              </Label>
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
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('inspector.trigger.filterSyncHint')}
          </p>
        </div>
      )}
    </>
  );
}
