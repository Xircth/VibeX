import { useState } from 'react';
import { Check, CirclePlay, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  return (
    <div className="space-y-3.5" data-testid="inspector-simple-overview">
      <div className="space-y-2 rounded-lg border border-border bg-muted/35 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {isSessionTestable ? (
            <span className="inline-flex h-5 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-2xs font-medium text-foreground">
              <StudioAgentIcon
                agentId={selectedStep.agentId}
                agentOptions={agentOptions}
                className="size-3.5 shrink-0"
              />
              <span>{presentation.identityBadge}</span>
            </span>
          ) : selectedStep.kind === 'bot' && presentation.botAvatar ? (
            <span className="inline-flex h-5 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-2xs font-medium text-foreground">
              <MemberBotAvatar
                config={presentation.botAvatar}
                animated={false}
                className="size-3.5 shrink-0"
              />
              <span>{presentation.identityBadge}</span>
            </span>
          ) : (
            <span className="inline-flex h-5 items-center rounded-md border border-border bg-card px-2 text-2xs font-medium text-foreground">
              {presentation.identityBadge}
            </span>
          )}

          {selectedStep.kind === 'trigger' ? (
            <span className="inline-flex h-5 items-center rounded-md bg-muted px-2 text-2xs text-muted-foreground tabular-nums">
              {selectedStep.triggerKind === 'temporal' && selectedStep.temporal
                ? formatWorkflowTemporalBadge(selectedStep.temporal, t)
                : `${formatWorkflowEventSource(selectedStep.sourceKind, t)} · ${selectedStep.eventType}`}
            </span>
          ) : null}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {presentation.humanRoleSummary}
        </p>
      </div>

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
          className="space-y-2.5 rounded-lg border border-warning/35 bg-warning/[0.06] p-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="workflow-approval-note">
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
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-warning/35 bg-warning/[0.06] p-3">
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
        <div className="space-y-3">
          {selectedStep.kind === 'trigger' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-trigger-title">
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
                <div className="space-y-1.5">
                  <Label htmlFor="inspector-trigger-cron">
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
              <div className="space-y-1.5">
                <Label htmlFor="inspector-step-agent">
                  {t('inspector.lightTweaks.agentLabel')}
                </Label>
                <select
                  id="inspector-step-agent"
                  data-testid="inspector-step-agent"
                  value={selectedStep.agentId}
                  onChange={(event) => {
                    const nextAgentId = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'session' || step.kind === 'agent'
                        ? { ...step, agentId: nextAgentId }
                        : step
                    );
                  }}
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {!agentOptions.some(
                    (option) => option.value === selectedStep.agentId
                  ) ? (
                    <option value={selectedStep.agentId}>
                      {selectedStep.agentId}
                    </option>
                  ) : null}
                  {agentOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-step-prompt">
                  {t('inspector.lightTweaks.promptLabel')}
                </Label>
                <textarea
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
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'bot' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-step-bot">
                  {t('inspector.lightTweaks.botLabel')}
                </Label>
                <select
                  id="inspector-step-bot"
                  data-testid="inspector-step-bot"
                  value={selectedStep.memberId}
                  onChange={(event) => {
                    const nextMemberId = event.target.value;
                    updateStep(selectedStep.id, (step) =>
                      step.kind === 'bot'
                        ? { ...step, memberId: nextMemberId }
                        : step
                    );
                  }}
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {!bots.some(
                    (bot) => bot.memberId === selectedStep.memberId
                  ) ? (
                    <option value={selectedStep.memberId}>
                      {presentation.identityBadge}
                    </option>
                  ) : null}
                  {bots.map((bot) => (
                    <option key={bot.memberId} value={bot.memberId}>
                      {bot.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-step-prompt">
                  {t('inspector.lightTweaks.promptLabel')}
                </Label>
                <textarea
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
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'group_stage' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-step-space">
                  {t('inspector.lightTweaks.groupLabel')}
                </Label>
                {spaces.length > 0 ? (
                  <select
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
                    className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {!spaces.some(
                      (space) => space.spaceId === selectedStep.spaceId
                    ) ? (
                      <option value={selectedStep.spaceId}>
                        {selectedStep.spaceId}
                      </option>
                    ) : null}
                    {spaces.map((space) => (
                      <option key={space.spaceId} value={space.spaceId}>
                        {space.displayName}
                      </option>
                    ))}
                  </select>
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
              <div className="space-y-1.5">
                <Label htmlFor="inspector-step-prompt">
                  {t('inspector.lightTweaks.promptLabel')}
                </Label>
                <textarea
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
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'user_gate' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-gate-title">
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
              <div className="space-y-1.5">
                <Label htmlFor="inspector-gate-body">
                  {t('inspector.lightTweaks.gateMessage')}
                </Label>
                <textarea
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
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'approval' || selectedStep.kind === 'notify' ? (
            <div className="space-y-1.5">
              <Label htmlFor="inspector-gate-title">
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
              <div className="space-y-1.5">
                <Label htmlFor="inspector-outbox-title">
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
              <div className="space-y-1.5">
                <Label htmlFor="inspector-outbox-message">
                  {t('inspector.lightTweaks.outboxMessage')}
                </Label>
                <textarea
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
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </>
          ) : null}

          {selectedStep.kind === 'control' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="inspector-control-title">
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
                <div className="space-y-1.5">
                  <Label htmlFor="inspector-loop-max">
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

      {onTestNode && isSessionTestable ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => {
              setInspectorTab('conversation');
              onTestNode(selectedStep.id);
            }}
          >
            <CirclePlay className="mr-1.5 size-3.5" />
            {t('studio.testNode')}
          </Button>
          {run && !onDefinitionChange && onRerunFromNode ? (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => onRerunFromNode(selectedStep.id)}
            >
              {t('studio.rerunDownstream')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {selectedRun?.outputJson || selectedRun?.candidateOutputJson ? (
        <details className="rounded-lg border border-border bg-muted/20" open>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {selectedRun.awaitingAcceptance
              ? t('studio.candidateOutput')
              : t('output')}
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border p-3 text-[11px] leading-5">
            {selectedRun.candidateOutputJson ?? selectedRun.outputJson}
          </pre>
        </details>
      ) : null}

      {onDefinitionChange && definition.steps.length > 1 ? (
        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={removeSelected}
          >
            <Trash2 className="mr-1.5 size-3.5" /> {t('studio.deleteNode')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
