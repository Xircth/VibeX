import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GroupDispatchMode } from '@/lib/api/pulse';

import type {
  ControlNodeKind,
  OutboxActionKind,
  StudioWorkflowStep,
  UserGateInteractionKind,
  UserGateSeverity,
} from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { formatOutboxActionLabel } from './workflowStepPresentation';

export function WorkflowStudioInspectorStagesAndFlow({
  selectedStep,
  studio,
}: {
  selectedStep: Exclude<
    StudioWorkflowStep,
    { kind: 'agent' | 'session' | 'bot' | 'trigger' }
  >;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    onDefinitionChange,
    updateStep,
    updateJson,
    definition,
    latest,
  } = studio;

  if (selectedStep.kind === 'group_stage') {
    return (
      <>
        <div className="space-y-1.5">
          <Label htmlFor="workflow-group-space">
            {t('inspector.group.spaceId')}
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
          <Label>{t('inspector.group.dispatchMode')}</Label>
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
              <SelectValue>
                {t(
                  `inspector.group.dispatchModes.${selectedStep.dispatchMode.type}`
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="specific_seat">
                {t('inspector.group.dispatchModes.specific_seat')}
              </SelectItem>
              <SelectItem value="mention_seats">
                {t('inspector.group.dispatchModes.mention_seats')}
              </SelectItem>
              <SelectItem value="moderator_triage">
                {t('inspector.group.dispatchModes.moderator_triage')}
              </SelectItem>
              <SelectItem value="broadcast_log_only">
                {t('inspector.group.dispatchModes.broadcast_log_only')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {selectedStep.dispatchMode.type === 'specific_seat' ? (
          <div className="space-y-1.5">
            <Label htmlFor="workflow-group-seat">
              {t('inspector.group.seatMemberId')}
            </Label>
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
              {t('inspector.group.mentionedSeats')}
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
              {t('inspector.group.moderatorMemberId')}
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
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="workflow-group-rounds">
                {t('inspector.group.rounds')}
              </Label>
              <Input
                id="workflow-group-rounds"
                type="number"
                min={1}
                data-testid="inspector-group-rounds"
                className="tabular-nums"
                placeholder={t('inspector.group.optionalPlaceholder')}
                value={selectedStep.rounds ?? ''}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'group_stage'
                      ? {
                          ...step,
                          rounds: event.target.value.trim()
                            ? Math.max(1, Number(event.target.value))
                            : null,
                        }
                      : step
                  )
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workflow-group-quorum">
                {t('inspector.group.quorum')}
              </Label>
              <Input
                id="workflow-group-quorum"
                type="number"
                min={1}
                data-testid="inspector-group-quorum"
                className="tabular-nums"
                placeholder={t('inspector.group.optionalPlaceholder')}
                value={selectedStep.quorumCount ?? ''}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'group_stage'
                      ? {
                          ...step,
                          quorumCount: event.target.value.trim()
                            ? Math.max(1, Number(event.target.value))
                            : null,
                        }
                      : step
                  )
                }
              />
            </div>
          </div>
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('inspector.group.convergenceHint')}
          </p>
        </div>

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
    );
  }

  if (selectedStep.kind === 'user_gate') {
    const severity: UserGateSeverity = selectedStep.severity ?? 'info';
    return (
      <>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1.5">
            <Label>{t('inspector.userGate.interactionKind')}</Label>
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
                <SelectValue>
                  {t(
                    `inspector.userGate.kinds.${selectedStep.interactionKind}`
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approval">
                  {t('inspector.userGate.kinds.approval')}
                </SelectItem>
                <SelectItem value="ask_form">
                  {t('inspector.userGate.kinds.ask_form')}
                </SelectItem>
                <SelectItem value="notify">
                  {t('inspector.userGate.kinds.notify')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('inspector.userGate.severity')}</Label>
            <Select
              value={severity}
              disabled={!onDefinitionChange}
              onValueChange={(nextSeverity: UserGateSeverity) =>
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'user_gate'
                    ? { ...step, severity: nextSeverity }
                    : step
                )
              }
            >
              <SelectTrigger data-testid="inspector-user-gate-severity">
                <SelectValue>
                  {t(`inspector.userGate.severities.${severity}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">
                  {t('inspector.userGate.severities.info')}
                </SelectItem>
                <SelectItem value="warning">
                  {t('inspector.userGate.severities.warning')}
                </SelectItem>
                <SelectItem value="urgent">
                  {t('inspector.userGate.severities.urgent')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-gate-sla">
              {t('inspector.userGate.slaSeconds')}
            </Label>
            <Input
              id="workflow-gate-sla"
              type="number"
              className="tabular-nums"
              value={selectedStep.slaTimeoutSeconds ?? ''}
              placeholder={t('inspector.userGate.optionalPlaceholder')}
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
          <Label htmlFor="workflow-gate-body">
            {t('inspector.userGate.bodyTemplate')}
          </Label>
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
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('inspector.userGate.hint')}
          </p>
        </div>
      </>
    );
  }

  if (selectedStep.kind === 'notify') {
    return (
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
    );
  }

  if (selectedStep.kind === 'approval') {
    return (
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
            defaultValue={JSON.stringify(selectedStep.decisionSchema, null, 2)}
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
    );
  }

  if (selectedStep.kind === 'control') {
    return (
      <>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5">
            <Label>{t('inspector.control.controlType')}</Label>
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
                <SelectValue>
                  {t(`inspector.control.types.${selectedStep.controlKind}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="condition">
                  {t('inspector.control.types.condition')}
                </SelectItem>
                <SelectItem value="bounded_loop">
                  {t('inspector.control.types.bounded_loop')}
                </SelectItem>
                <SelectItem value="wait_for_event">
                  {t('inspector.control.types.wait_for_event')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-control-title">{t('studio.title')}</Label>
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
                  {t('inspector.control.maxIterations')}
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
                  {t('inspector.control.loopTargetStepId')}
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
                {t('validation.invalidBoundedLoopMaxIterations')}
              </p>
            ) : null}
          </div>
        ) : selectedStep.controlKind === 'wait_for_event' ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label htmlFor="workflow-wait-event">
                  {t('inspector.control.waitEventType')}
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
                  {t('inspector.control.threadKeyTemplate')}
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
            <div className="space-y-1.5">
              <Label htmlFor="workflow-wait-timeout">
                {t('inspector.control.timeoutSeconds')}
              </Label>
              <Input
                id="workflow-wait-timeout"
                type="number"
                className="tabular-nums"
                placeholder={t('inspector.userGate.optionalPlaceholder')}
                value={selectedStep.timeoutSeconds ?? ''}
                disabled={!onDefinitionChange}
                onChange={(event) =>
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'control'
                      ? {
                          ...step,
                          timeoutSeconds: event.target.value.trim()
                            ? Number(event.target.value)
                            : null,
                        }
                      : step
                  )
                }
              />
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {t('inspector.control.waitHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="workflow-condition-expr">
              {t('inspector.control.branchExpression')}
            </Label>
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
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="space-y-1.5">
          <Label>{t('inspector.outbox.targetKind')}</Label>
          <Select
            value={selectedStep.actionKind}
            disabled={!onDefinitionChange}
            onValueChange={(actionKind: OutboxActionKind) =>
              updateStep(selectedStep.id, (step) =>
                step.kind === 'outbox_action' ? { ...step, actionKind } : step
              )
            }
          >
            <SelectTrigger data-testid="inspector-outbox-kind">
              <SelectValue>
                {formatOutboxActionLabel(selectedStep.actionKind, t)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="feishu_reply">
                {formatOutboxActionLabel('feishu_reply', t)}
              </SelectItem>
              <SelectItem value="jira_comment">
                {formatOutboxActionLabel('jira_comment', t)}
              </SelectItem>
              <SelectItem value="github_comment">
                {formatOutboxActionLabel('github_comment', t)}
              </SelectItem>
              <SelectItem value="webhook_post">
                {formatOutboxActionLabel('webhook_post', t)}
              </SelectItem>
              <SelectItem value="emit_event">
                {formatOutboxActionLabel('emit_event', t)}
              </SelectItem>
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
          {t('inspector.outbox.destination')}
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
          {t('inspector.outbox.payloadTemplate')}
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
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t('inspector.outbox.hint')}
        </p>
      </div>
    </>
  );
}
