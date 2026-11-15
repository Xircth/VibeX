import { useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CirclePlay,
  Trash2,
  X,
} from 'lucide-react';
import type { JsonValue } from 'shared/types';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import type {
  StudioInspectorTier,
  StudioJoinMode,
  StudioWorkflowStep,
} from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import {
  getStepOutputPorts,
  isMultiPortStep,
  resolveValidSourceHandle,
} from './workflowPorts';
import { WorkflowStudioInspectorAdvanced } from './WorkflowStudioInspectorAdvanced';
import { WorkflowStudioInspectorJson } from './WorkflowStudioInspectorJson';
import { WorkflowStudioInspectorVisual } from './WorkflowStudioInspectorVisual';
import { validateStudioStepExhaustively } from './workflowValidation';

function canSaveStudioStep(step: StudioWorkflowStep): boolean {
  return validateStudioStepExhaustively(step).length === 0;
}

const INSPECTOR_TIER_IDS: readonly StudioInspectorTier[] = [
  'visual',
  'advanced',
  'json',
];

export function WorkflowStudioInspectorInfo({
  selectedStep,
  studio,
}: {
  selectedStep: StudioWorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    selectedSuccessors,
    onDefinitionChange,
    definition,
    jsonError,
    selectedStepSaved,
    setUnsavedStepIds,
    setInspectorTab,
    inspectorTier,
    setInspectorTier,
    onTestNode,
    selectedRun,
    onAcceptCandidate,
    decisionJson,
    setDecisionJson,
    decisionError,
    setDecisionError,
    onDecideApproval,
    onReview,
    run,
    onRerunFromNode,
    removeSelected,
    disconnect,
    updateStep,
  } = studio;
  const [approvalNote, setApprovalNote] = useState('');
  const tabButtonRefs = useRef<Record<StudioInspectorTier, HTMLButtonElement | null>>({
    visual: null,
    advanced: null,
    json: null,
  });

  const stepIssues = useMemo(() => {
    const ids = new Set(definition.steps.map((item) => item.id));
    return validateStudioStepExhaustively(selectedStep, ids, undefined, t);
  }, [definition.steps, selectedStep, t]);

  const isSessionTestable =
    selectedStep.kind === 'agent' || selectedStep.kind === 'session';

  const movePredecessor = (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= selectedStep.dependsOn.length) {
      return;
    }
    updateStep(selectedStep.id, (step) => {
      const nextDeps = [...step.dependsOn];
      const [moved] = nextDeps.splice(index, 1);
      if (!moved) return step;
      nextDeps.splice(targetIndex, 0, moved);
      return { ...step, dependsOn: nextDeps };
    });
  };

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={t('inspector.modeAriaLabel')}
        className="flex items-center rounded-lg border border-border bg-muted/65 p-0.5"
      >
        {INSPECTOR_TIER_IDS.map((tierId, index) => (
          <button
            key={tierId}
            ref={(node) => {
              tabButtonRefs.current[tierId] = node;
            }}
            type="button"
            role="tab"
            tabIndex={inspectorTier === tierId ? 0 : -1}
            aria-selected={inspectorTier === tierId}
            data-testid={`inspector-tier-${tierId}`}
            onClick={() => setInspectorTier(tierId)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                return;
              }
              event.preventDefault();
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const nextIndex =
                (index + delta + INSPECTOR_TIER_IDS.length) %
                INSPECTOR_TIER_IDS.length;
              const nextTier = INSPECTOR_TIER_IDS[nextIndex];
              setInspectorTier(nextTier);
              tabButtonRefs.current[nextTier]?.focus();
            }}
            className={cn(
              'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
              inspectorTier === tierId
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <span>{t(`inspector.tiers.${tierId}`)}</span>
            {tierId === 'json' && stepIssues.length > 0 ? (
              <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-destructive">
                {stepIssues.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {inspectorTier !== 'json' ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('studio.predecessors')}</Label>
              <div className="flex min-h-8 flex-col justify-center gap-1 rounded-lg bg-muted/55 px-2 py-1.5">
                {selectedStep.dependsOn.length === 0 ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t('studio.none')}
                  </span>
                ) : (
                  selectedStep.dependsOn.map((depId, depIndex) => {
                    const predStep = definition.steps.find(
                      (candidate) => candidate.id === depId
                    );
                    const predMultiPort = Boolean(
                      predStep && isMultiPortStep(predStep)
                    );
                    const predPorts = predStep
                      ? getStepOutputPorts(predStep, t)
                      : [];
                    const activeHandle = resolveValidSourceHandle(
                      predStep,
                      selectedStep.branchPorts?.[depId]
                    );
                    return (
                      <div
                        key={depId}
                        data-testid={`inspector-predecessor-row-${depId}`}
                        className="flex flex-wrap items-center justify-between gap-1 rounded-md bg-card px-1.5 py-1 shadow-sm"
                      >
                        <span className="truncate font-mono text-[10px] font-medium text-foreground">
                          {depId}
                        </span>
                        <div className="flex items-center gap-0.5">
                          {predMultiPort && onDefinitionChange ? (
                            <select
                              aria-label={t('inspector.flow.branchPortAria', {
                                id: depId,
                              })}
                              data-testid={`inspector-predecessor-port-${depId}`}
                              value={activeHandle}
                              onChange={(event) => {
                                const nextHandle = event.target.value;
                                updateStep(selectedStep.id, (step) => ({
                                  ...step,
                                  branchPorts: {
                                    ...(step.branchPorts ?? {}),
                                    [depId]: nextHandle,
                                  },
                                }));
                              }}
                              className="h-5 rounded border border-border bg-background px-1 text-2xs font-medium text-foreground outline-none"
                            >
                              {predPorts.map((port) => (
                                <option key={port.id} value={port.id}>
                                  {port.shortLabel || port.label}
                                </option>
                              ))}
                            </select>
                          ) : predMultiPort ? (
                            <span className="rounded bg-muted px-1 py-0.5 text-2xs text-muted-foreground">
                              {predPorts.find((p) => p.id === activeHandle)
                                ?.shortLabel ?? activeHandle}
                            </span>
                          ) : null}
                          {onDefinitionChange &&
                          selectedStep.dependsOn.length >= 2 ? (
                            <>
                              <button
                                type="button"
                                disabled={depIndex === 0}
                                aria-label={t(
                                  'inspector.flow.movePredecessorUp',
                                  { id: depId }
                                )}
                                data-testid={`inspector-predecessor-up-${depId}`}
                                onClick={() => movePredecessor(depIndex, -1)}
                                className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
                              >
                                <ArrowUp className="size-3" />
                              </button>
                              <button
                                type="button"
                                disabled={
                                  depIndex ===
                                  selectedStep.dependsOn.length - 1
                                }
                                aria-label={t(
                                  'inspector.flow.movePredecessorDown',
                                  { id: depId }
                                )}
                                data-testid={`inspector-predecessor-down-${depId}`}
                                onClick={() => movePredecessor(depIndex, 1)}
                                className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
                              >
                                <ArrowDown className="size-3" />
                              </button>
                            </>
                          ) : null}
                          {onDefinitionChange ? (
                            <button
                              type="button"
                              aria-label={t(
                                'inspector.flow.disconnectPredecessor',
                                { id: depId }
                              )}
                              data-testid={`inspector-predecessor-disconnect-${depId}`}
                              onClick={() => disconnect(depId, selectedStep.id)}
                              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                            >
                              <X className="size-3" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('studio.successors')}</Label>
              <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg bg-muted/55 px-2 py-1.5">
                {selectedSuccessors.length === 0 ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t('studio.none')}
                  </span>
                ) : (
                  selectedSuccessors.map((value) => (
                    <span
                      key={value}
                      className="rounded-full bg-card px-2 py-0.5 font-mono text-[10px] shadow-sm"
                    >
                      {value}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          {selectedStep.kind !== 'trigger' &&
          selectedStep.dependsOn.length >= 2 ? (
            <div
              data-testid="inspector-join-mode"
              className="space-y-1.5 rounded-lg border border-border bg-muted/35 p-2.5"
            >
              <Label>{t('inspector.flow.joinModeLabel')}</Label>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/60 p-0.5">
                {(['all', 'any'] as const satisfies readonly StudioJoinMode[]).map(
                  (modeOption) => {
                    const currentJoin = selectedStep.joinMode ?? 'all';
                    const active = currentJoin === modeOption;
                    return (
                      <button
                        key={modeOption}
                        type="button"
                        disabled={!onDefinitionChange}
                        aria-pressed={active}
                        data-testid={`inspector-join-mode-${modeOption}`}
                        onClick={() =>
                          updateStep(selectedStep.id, (step) => ({
                            ...step,
                            joinMode: modeOption,
                          }))
                        }
                        className={cn(
                          'flex h-7 items-center justify-center rounded px-2 text-xs font-medium transition-colors disabled:opacity-60',
                          active
                            ? 'bg-card text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {t(
                          modeOption === 'any'
                            ? 'inspector.flow.joinModeAny'
                            : 'inspector.flow.joinModeAll'
                        )}
                      </button>
                    );
                  }
                )}
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t('inspector.flow.joinModeHint')}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {inspectorTier === 'visual' ? (
        <WorkflowStudioInspectorVisual
          selectedStep={selectedStep}
          studio={studio}
        />
      ) : inspectorTier === 'advanced' ? (
        <WorkflowStudioInspectorAdvanced
          selectedStep={selectedStep}
          studio={studio}
        />
      ) : (
        <WorkflowStudioInspectorJson
          selectedStep={selectedStep}
          studio={studio}
        />
      )}

      {jsonError ? (
        <p role="alert" className="text-xs text-destructive">
          {jsonError}
        </p>
      ) : null}
      {onDefinitionChange ? (
        <div className="grid grid-cols-2 gap-2 pt-3">
          <Button
            variant="outline"
            disabled={selectedStepSaved || !canSaveStudioStep(selectedStep)}
            onClick={() =>
              setUnsavedStepIds((current) => {
                const next = new Set(current);
                next.delete(selectedStep.id);
                return next;
              })
            }
          >
            <Check className="mr-1.5 size-3.5" />
            {t('studio.saveNode')}
          </Button>
          {isSessionTestable ? (
            <Button
              disabled={!selectedStepSaved || !onTestNode}
              onClick={() => {
                setInspectorTab('conversation');
                onTestNode?.(selectedStep.id);
              }}
            >
              <CirclePlay className="mr-1.5 size-3.5" />
              {t('studio.testNode')}
            </Button>
          ) : (
            <span />
          )}
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
        <div className="space-y-2 rounded-lg border border-warning/35 bg-warning/[0.06] p-3">
          <div className="space-y-1.5">
            <Label htmlFor="workflow-approval-note">
              {t('inspector.approvalNoteLabel')}
            </Label>
            <input
              id="workflow-approval-note"
              type="text"
              value={approvalNote}
              onChange={(event) => setApprovalNote(event.target.value)}
              placeholder={t('inspector.approvalNotePlaceholder')}
              className="h-8 w-full rounded-md border bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
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
          <Label htmlFor="workflow-approval-decision">
            {t('studio.decisionJson')}
          </Label>
          <textarea
            id="workflow-approval-decision"
            value={decisionJson}
            onChange={(event) => setDecisionJson(event.target.value)}
            className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {decisionError ? (
            <p role="alert" className="text-xs text-destructive">
              {decisionError}
            </p>
          ) : null}
          <Button
            className="w-full"
            onClick={() => {
              try {
                const decision = JSON.parse(decisionJson) as JsonValue;
                setDecisionError(null);
                void onDecideApproval?.(selectedStep.id, decision);
              } catch {
                setDecisionError(t('invalidDecision'));
              }
            }}
          >
            {t('submitDecision')}
          </Button>
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
      {run && !onDefinitionChange && isSessionTestable ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            onClick={() => onTestNode?.(selectedStep.id)}
          >
            {t('studio.testNode')}
          </Button>
          <Button
            variant="outline"
            onClick={() => onRerunFromNode?.(selectedStep.id)}
          >
            {t('studio.rerunDownstream')}
          </Button>
        </div>
      ) : null}
      {onDefinitionChange ? (
        <Button
          variant="destructive"
          className="w-full"
          onClick={removeSelected}
          disabled={definition.steps.length === 1}
        >
          <Trash2 className="mr-1.5 size-3.5" /> {t('studio.deleteNode')}
        </Button>
      ) : null}
      {selectedRun?.resolvedInputJson ? (
        <details className="rounded-lg border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {t('resolvedInput')}
          </summary>
          <pre className="max-h-56 overflow-auto border-t p-3 text-[11px] leading-5">
            {selectedRun.resolvedInputJson}
          </pre>
        </details>
      ) : null}
      {selectedRun?.outputJson || selectedRun?.candidateOutputJson ? (
        <details className="rounded-lg border bg-muted/20" open>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {selectedRun.awaitingAcceptance
              ? t('studio.candidateOutput')
              : t('output')}
          </summary>
          <pre className="max-h-56 overflow-auto border-t p-3 text-[11px] leading-5">
            {selectedRun.candidateOutputJson ?? selectedRun.outputJson}
          </pre>
        </details>
      ) : null}
      {selectedRun?.executionEvidenceJson ? (
        <details className="rounded-lg border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {t('executionEvidence')}
          </summary>
          <pre className="max-h-56 overflow-auto border-t p-3 text-[11px] leading-5">
            {selectedRun.executionEvidenceJson}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
