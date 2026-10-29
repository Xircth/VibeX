import { Check, CirclePlay, Trash2 } from 'lucide-react';
import type { JsonValue, WorkflowStep } from 'shared/types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowStudioInspectorAgent } from './WorkflowStudioInspectorAgent';

export function WorkflowStudioInspectorInfo({
  selectedStep,
  studio,
}: {
  selectedStep: WorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    selectedSuccessors,
    onDefinitionChange,
    updateStep,
    updateJson,
    definition,
    latest,
    jsonError,
    selectedStepSaved,
    setUnsavedStepIds,
    setInspectorTab,
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
  } = studio;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[
          {
            label: t('studio.predecessors'),
            values: selectedStep.dependsOn,
          },
          {
            label: t('studio.successors'),
            values: selectedSuccessors,
          },
        ].map((relation) => (
          <div key={relation.label} className="space-y-1.5">
            <Label>{relation.label}</Label>
            <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg bg-muted/55 px-2 py-1.5">
              {relation.values.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">
                  {t('studio.none')}
                </span>
              ) : (
                relation.values.map((value) => (
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
        ))}
      </div>
      {selectedStep.kind === 'notify' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-notify-title">{t('studio.title')}</Label>
            <Input
              id="workflow-notify-title"
              value={selectedStep.title}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) => ({
                  ...step,
                  title: event.target.value,
                }))
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
      ) : selectedStep.kind === 'agent' ? (
        <WorkflowStudioInspectorAgent
          selectedStep={selectedStep}
          studio={studio}
        />
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-approval-title">{t('studio.title')}</Label>
            <Input
              id="workflow-approval-title"
              value={selectedStep.title}
              disabled={!onDefinitionChange}
              onChange={(event) =>
                updateStep(selectedStep.id, (step) => ({
                  ...step,
                  title: event.target.value,
                }))
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
                updateStep(selectedStep.id, (step) => ({
                  ...step,
                  approverScope: event.target.value,
                }))
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
                    updateStep(selectedStep.id, (step) => ({
                      ...step,
                      decisionSchema,
                    }));
                })
              }
              className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[11px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
            />
          </div>
        </>
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
            disabled={
              selectedStepSaved ||
              (selectedStep.kind === 'agent'
                ? !selectedStep.prompt.trim()
                : !selectedStep.title.trim())
            }
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
          {selectedStep.kind === 'agent' ? (
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
      {selectedStep.kind === 'approval' &&
      selectedRun?.status === 'waiting_approval' ? (
        <div className="space-y-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-3">
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
      {selectedRun?.status === 'needs_review' &&
      selectedStep.kind === 'agent' ? (
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-3">
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
      {run && !onDefinitionChange && selectedStep.kind === 'agent' ? (
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
