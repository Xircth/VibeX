import { useMemo, useState } from 'react';
import { Check, CirclePlay, Trash2 } from 'lucide-react';

import {
  AstryxSelect,
  type AstryxSelectOption,
} from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MemberBotAvatar } from '@/features/collaboration/MemberBotAvatar';

import { StudioAgentIcon } from './StudioAgentIcon';
import type { StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import {
  describeStepPresentation,
  formatWorkflowEventSource,
  formatWorkflowTemporalBadge,
} from './workflowStepPresentation';

export function WorkflowStudioInspectorInfo({
  selectedStep,
  studio,
}: {
  selectedStep: StudioWorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    onDefinitionChange,
    definition,
    agentOptions,
    bots,
    spaces,
    outputLanguage,
    setInspectorTab,
    onTestNode,
    selectedRun,
    onAcceptCandidate,
    setDecisionError,
    onDecideApproval,
    onReview,
    run,
    onRerunFromNode,
    removeSelected,
    updateStep,
  } = studio;

  const [approvalNote, setApprovalNote] = useState('');

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

  const isSessionTestable =
    selectedStep.kind === 'agent' || selectedStep.kind === 'session';

  const agentSelectOptions = useMemo<AstryxSelectOption[]>(() => {
    const currentAgentId =
      selectedStep.kind === 'agent' || selectedStep.kind === 'session'
        ? selectedStep.agentId
        : '';
    const base: AstryxSelectOption[] = [];
    if (
      currentAgentId &&
      !agentOptions.some((option) => option.value === currentAgentId)
    ) {
      base.push({
        value: currentAgentId,
        label: currentAgentId,
        icon: (
          <StudioAgentIcon
            agentId={currentAgentId}
            agentOptions={agentOptions}
            className="size-3.5 shrink-0"
          />
        ),
      });
    }
    for (const option of agentOptions) {
      base.push({
        value: option.value,
        label: option.label,
        icon: (
          <StudioAgentIcon
            agentId={option.value}
            agentOptions={agentOptions}
            className="size-3.5 shrink-0"
          />
        ),
      });
    }
    return base;
  }, [agentOptions, selectedStep]);

  const botSelectOptions = useMemo<AstryxSelectOption[]>(() => {
    const currentMemberId =
      selectedStep.kind === 'bot' ? selectedStep.memberId : '';
    const base: AstryxSelectOption[] = [];
    if (
      currentMemberId &&
      !bots.some((bot) => bot.memberId === currentMemberId)
    ) {
      base.push({
        value: currentMemberId,
        label: presentation.identityBadge,
        icon: presentation.botAvatar ? (
          <MemberBotAvatar
            config={presentation.botAvatar}
            animated={false}
            className="size-3.5 shrink-0"
          />
        ) : undefined,
      });
    }
    for (const bot of bots) {
      base.push({
        value: bot.memberId,
        label: bot.displayName,
        icon: (
          <MemberBotAvatar
            config={bot.avatar}
            animated={false}
            className="size-3.5 shrink-0"
          />
        ),
      });
    }
    return base;
  }, [bots, presentation.botAvatar, presentation.identityBadge, selectedStep]);

  const spaceSelectOptions = useMemo<AstryxSelectOption[]>(() => {
    const currentSpaceId =
      selectedStep.kind === 'group_stage' ? selectedStep.spaceId : '';
    const base: AstryxSelectOption[] = [];
    if (
      currentSpaceId &&
      !spaces.some((space) => space.spaceId === currentSpaceId)
    ) {
      base.push({
        value: currentSpaceId,
        label: currentSpaceId,
      });
    }
    for (const space of spaces) {
      base.push({
        value: space.spaceId,
        label: space.displayName,
      });
    }
    return base;
  }, [selectedStep, spaces]);

  return (
    <div className="space-y-3" data-testid="inspector-simple-overview">
      {selectedStep.kind === 'trigger' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex h-5 items-center rounded-[var(--radius-inner)] bg-muted/70 px-2 text-2xs font-medium text-foreground">
            {presentation.identityBadge}
          </span>
          <span className="inline-flex h-5 items-center rounded-[var(--radius-inner)] bg-muted/50 px-2 font-mono text-2xs text-muted-foreground tabular-nums">
            {selectedStep.triggerKind === 'temporal' && selectedStep.temporal
              ? formatWorkflowTemporalBadge(selectedStep.temporal, t)
              : `${formatWorkflowEventSource(selectedStep.sourceKind, t)} · ${selectedStep.eventType}`}
          </span>
        </div>
      ) : null}

      {selectedRun?.awaitingAcceptance ? (
        <Button
          className="w-full"
          onClick={() => onAcceptCandidate?.(selectedStep.id)}
        >
          <Check className="mr-1.5 size-3.5" /> {t('studio.acceptCandidate')}
        </Button>
      ) : null}

      {(selectedStep.kind === 'approval' ||
        selectedStep.kind === 'user_gate' ||
        selectedRun?.status === 'waiting_approval') &&
      selectedRun?.status === 'waiting_approval' ? (
        <div
          data-testid="inspector-approval-card"
          className="space-y-2.5 rounded-[var(--radius-element)] bg-warning/[0.08] p-3"
        >
          <div className="space-y-1">
            <Label
              htmlFor="workflow-approval-note"
              className="text-[11px] text-muted-foreground"
            >
              {t('inspector.approvalNoteLabel')}
            </Label>
            <Input
              id="workflow-approval-note"
              value={approvalNote}
              onChange={(event) => setApprovalNote(event.target.value)}
              placeholder={t('inspector.approvalNotePlaceholder')}
              className="h-8 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="inspector-approve-btn"
              onClick={() => {
                setDecisionError(null);
                const trimmed = approvalNote.trim();
                void onDecideApproval?.(selectedStep.id, {
                  approved: true,
                  optionId: 'approve',
                  ...(trimmed ? { note: trimmed } : {}),
                });
                setApprovalNote('');
              }}
            >
              {t('inspector.approve')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid="inspector-reject-btn"
              onClick={() => {
                setDecisionError(null);
                const trimmed = approvalNote.trim();
                void onDecideApproval?.(selectedStep.id, {
                  approved: false,
                  optionId: 'reject',
                  ...(trimmed ? { note: trimmed } : {}),
                });
                setApprovalNote('');
              }}
            >
              {t('inspector.reject')}
            </Button>
          </div>
        </div>
      ) : null}

      {selectedRun?.status === 'needs_review' && isSessionTestable ? (
        <div className="grid grid-cols-3 gap-2 rounded-[var(--radius-element)] bg-warning/[0.08] p-2.5">
          <Button
            size="sm"
            onClick={() =>
              void onReview?.({
                kind: 'retry',
                step_id: selectedStep.id,
              })
            }
          >
            {t('studio.retry')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void onReview?.({
                kind: 'accept',
                step_id: selectedStep.id,
                output: null,
              })
            }
          >
            {t('studio.accept')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!selectedStep.allowSkipOnReview}
            onClick={() =>
              void onReview?.({
                kind: 'skip',
                step_id: selectedStep.id,
              })
            }
          >
            {t('studio.skip')}
          </Button>
        </div>
      ) : null}

      {onDefinitionChange ? (
        <div className="space-y-2.5">
          {selectedStep.kind === 'trigger' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-trigger-title"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.triggerTitle')}
                </Label>
                <Input
                  id="inspector-trigger-title"
                  data-testid="inspector-trigger-title"
                  value={selectedStep.title}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'trigger'
                        ? { ...step, title: nextTitle }
                        : step
                    );
                  }}
                  className="h-8 text-xs"
                />
              </div>
              {selectedStep.triggerKind === 'temporal' &&
              selectedStep.temporal?.kind === 'cron' ? (
                <div className="space-y-1">
                  <Label
                    htmlFor="inspector-trigger-cron"
                    className="text-[11px] text-muted-foreground"
                  >
                    {t('inspector.lightTweaks.cronExpression')}
                  </Label>
                  <Input
                    id="inspector-trigger-cron"
                    data-testid="inspector-trigger-cron"
                    value={selectedStep.temporal.expression}
                    onChange={(event) => {
                      const nextExpr = event.target.value;
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'trigger' &&
                        step.temporal?.kind === 'cron'
                          ? {
                              ...step,
                              temporal: {
                                ...step.temporal,
                                expression: nextExpr,
                              },
                            }
                          : step
                      );
                    }}
                    className="h-8 font-mono text-xs tabular-nums"
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {selectedStep.kind === 'session' || selectedStep.kind === 'agent' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-step-agent"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.agentLabel')}
                </Label>
                <AstryxSelect
                  id="inspector-step-agent"
                  data-testid="inspector-step-agent"
                  ariaLabel={t('inspector.lightTweaks.agentLabel')}
                  value={selectedStep.agentId}
                  options={agentSelectOptions}
                  showSelectedIcon
                  size="compact"
                  className="w-full"
                  onChange={(nextAgentId) => {
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'session' || step.kind === 'agent'
                        ? { ...step, agentId: nextAgentId }
                        : step
                    );
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-step-prompt"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.promptLabel')}
                </Label>
                <Textarea
                  id="inspector-step-prompt"
                  data-testid="inspector-step-prompt"
                  value={selectedStep.prompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'session' || step.kind === 'agent'
                        ? { ...step, prompt: nextPrompt }
                        : step
                    );
                  }}
                  rows={4}
                  className="min-h-[88px] resize-y text-xs leading-relaxed"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'bot' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-step-bot"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.botLabel')}
                </Label>
                <AstryxSelect
                  id="inspector-step-bot"
                  data-testid="inspector-step-bot"
                  ariaLabel={t('inspector.lightTweaks.botLabel')}
                  value={selectedStep.memberId}
                  options={botSelectOptions}
                  showSelectedIcon
                  size="compact"
                  className="w-full"
                  onChange={(nextMemberId) => {
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'bot'
                        ? { ...step, memberId: nextMemberId }
                        : step
                    );
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-step-prompt"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.promptLabel')}
                </Label>
                <Textarea
                  id="inspector-step-prompt"
                  data-testid="inspector-step-prompt"
                  value={selectedStep.prompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'bot'
                        ? { ...step, prompt: nextPrompt }
                        : step
                    );
                  }}
                  rows={4}
                  className="min-h-[88px] resize-y text-xs leading-relaxed"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'group_stage' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-step-space"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.groupLabel')}
                </Label>
                {spaces.length > 0 ? (
                  <AstryxSelect
                    id="inspector-step-space"
                    data-testid="inspector-step-space"
                    ariaLabel={t('inspector.lightTweaks.groupLabel')}
                    value={selectedStep.spaceId}
                    options={spaceSelectOptions}
                    size="compact"
                    className="w-full"
                    onChange={(nextSpaceId) => {
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'group_stage'
                          ? { ...step, spaceId: nextSpaceId }
                          : step
                      );
                    }}
                  />
                ) : (
                  <Input
                    id="inspector-step-space"
                    data-testid="inspector-step-space"
                    value={selectedStep.spaceId}
                    onChange={(event) => {
                      const nextSpaceId = event.target.value;
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'group_stage'
                          ? { ...step, spaceId: nextSpaceId }
                          : step
                      );
                    }}
                    className="h-8 text-xs"
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-step-prompt"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.promptLabel')}
                </Label>
                <Textarea
                  id="inspector-step-prompt"
                  data-testid="inspector-step-prompt"
                  value={selectedStep.prompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'group_stage'
                        ? { ...step, prompt: nextPrompt }
                        : step
                    );
                  }}
                  rows={3}
                  className="min-h-[76px] resize-y text-xs leading-relaxed"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'user_gate' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-gate-title"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.gateTitle')}
                </Label>
                <Input
                  id="inspector-gate-title"
                  data-testid="inspector-gate-title"
                  value={selectedStep.title}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'user_gate'
                        ? { ...step, title: nextTitle }
                        : step
                    );
                  }}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-gate-body"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.gateMessage')}
                </Label>
                <Textarea
                  id="inspector-gate-body"
                  data-testid="inspector-gate-body"
                  value={selectedStep.bodyTemplate}
                  onChange={(event) => {
                    const nextBody = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'user_gate'
                        ? { ...step, bodyTemplate: nextBody }
                        : step
                    );
                  }}
                  rows={3}
                  className="min-h-[76px] resize-y text-xs leading-relaxed"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'approval' ||
          selectedStep.kind === 'notify' ? (
            <div className="space-y-1">
              <Label
                htmlFor="inspector-gate-title"
                className="text-[11px] text-muted-foreground"
              >
                {t('inspector.lightTweaks.gateTitle')}
              </Label>
              <Input
                id="inspector-gate-title"
                data-testid="inspector-gate-title"
                value={selectedStep.title}
                onChange={(event) => {
                  const nextTitle = event.target.value;
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'approval' || step.kind === 'notify'
                      ? { ...step, title: nextTitle }
                      : step
                  );
                }}
                className="h-8 text-xs"
              />
            </div>
          ) : null}

          {selectedStep.kind === 'outbox_action' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-outbox-title"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.outboxTitle')}
                </Label>
                <Input
                  id="inspector-outbox-title"
                  data-testid="inspector-outbox-title"
                  value={selectedStep.title}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'outbox_action'
                        ? { ...step, title: nextTitle }
                        : step
                    );
                  }}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-outbox-message"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.outboxMessage')}
                </Label>
                <Textarea
                  id="inspector-outbox-message"
                  data-testid="inspector-outbox-message"
                  value={selectedStep.payloadTemplate}
                  onChange={(event) => {
                    const nextPayload = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'outbox_action'
                        ? { ...step, payloadTemplate: nextPayload }
                        : step
                    );
                  }}
                  rows={3}
                  className="min-h-[76px] resize-y text-xs leading-relaxed"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'control' ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor="inspector-control-title"
                  className="text-[11px] text-muted-foreground"
                >
                  {t('inspector.lightTweaks.controlTitle')}
                </Label>
                <Input
                  id="inspector-control-title"
                  data-testid="inspector-control-title"
                  value={selectedStep.title}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'control'
                        ? { ...step, title: nextTitle }
                        : step
                    );
                  }}
                  className="h-8 text-xs"
                />
              </div>
              {selectedStep.controlKind === 'bounded_loop' ? (
                <div className="space-y-1">
                  <Label
                    htmlFor="inspector-loop-max"
                    className="text-[11px] text-muted-foreground"
                  >
                    {t('inspector.lightTweaks.maxRounds')}
                  </Label>
                  <Input
                    id="inspector-loop-max"
                    data-testid="inspector-loop-max"
                    type="number"
                    min={1}
                    max={50}
                    value={String(selectedStep.maxIterations ?? 3)}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(parsed)) return;
                      updateStep(selectedStep.id, (step) =>
                        step.kind === 'control' &&
                        step.controlKind === 'bounded_loop'
                          ? {
                              ...step,
                              maxIterations: Math.min(50, Math.max(1, parsed)),
                            }
                          : step
                      );
                    }}
                    className="h-8 w-28 text-xs tabular-nums"
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {(onTestNode && isSessionTestable) ||
      (onDefinitionChange && definition.steps.length > 1) ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {onTestNode && isSessionTestable ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="inspector-test-node-btn"
              className="h-7 flex-1 text-xs"
              onClick={() => {
                setInspectorTab('conversation');
                onTestNode(selectedStep.id);
              }}
            >
              <CirclePlay className="mr-1.5 size-3.5" />
              {t('studio.testNode')}
            </Button>
          ) : null}
          {run &&
          !onDefinitionChange &&
          onRerunFromNode &&
          isSessionTestable ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-xs"
              onClick={() => onRerunFromNode(selectedStep.id)}
            >
              {t('studio.rerunDownstream')}
            </Button>
          ) : null}
          {onDefinitionChange && definition.steps.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              className={
                onTestNode && isSessionTestable
                  ? 'h-7 px-2.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                  : 'h-7 w-full text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
              }
              onClick={removeSelected}
            >
              <Trash2 className="mr-1 size-3.5" />
              {t('studio.deleteNode')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {selectedRun?.outputJson || selectedRun?.candidateOutputJson ? (
        <details
          className="rounded-[var(--radius-element)] bg-muted/35 p-2.5"
          open
        >
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            {selectedRun.awaitingAcceptance
              ? t('studio.candidateOutput')
              : t('output')}
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-[var(--radius-inner)] bg-background/75 p-2.5 text-[11px] leading-5">
            {selectedRun.candidateOutputJson ?? selectedRun.outputJson}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
