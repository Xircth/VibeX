import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { StudioWorkflowDefinition, StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { renameBranchPortKeys } from './workflowPorts';
import {
  validateStudioStepExhaustively,
  validateStudioWorkflowExhaustively,
  type WorkflowValidationIssue,
} from './workflowValidation';

type JsonScope = 'step' | 'workflow';

function serializePretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === 'bigint' ? Number(item) : item),
    2
  );
}

export function WorkflowStudioInspectorJson({
  selectedStep,
  studio,
}: {
  selectedStep: StudioWorkflowStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    definition,
    onDefinitionChange,
    updateStep,
    setSelectedStepId,
  } = studio;

  const [scope, setScope] = useState<JsonScope>('step');
  const [draft, setDraft] = useState(() => serializePretty(selectedStep));
  const [syntaxError, setSyntaxError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      serializePretty(scope === 'step' ? selectedStep : definition)
    );
    setSyntaxError(null);
  }, [definition, scope, selectedStep]);

  const allStepIds = useMemo(
    () => new Set(definition.steps.map((step) => step.id)),
    [definition.steps]
  );

  const liveInspection = useMemo((): {
    parseError: string | null;
    issues: WorkflowValidationIssue[];
  } => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          parseError: t('inspector.json.errors.rootObjectRequired'),
          issues: [],
        };
      }
      if (scope === 'step') {
        const candidateStep = parsed as StudioWorkflowStep;
        if (typeof candidateStep.kind !== 'string') {
          return {
            parseError: t('inspector.json.errors.stepKindRequired'),
            issues: [],
          };
        }
        const idsWithCandidate = new Set(allStepIds);
        idsWithCandidate.delete(selectedStep.id);
        if (candidateStep.id) idsWithCandidate.add(candidateStep.id);
        return {
          parseError: null,
          issues: validateStudioStepExhaustively(
            candidateStep,
            idsWithCandidate,
            `steps[${candidateStep.id || '?'}]`,
            t
          ),
        };
      }

      const candidateWorkflow = parsed as StudioWorkflowDefinition;
      return {
        parseError: null,
        issues: validateStudioWorkflowExhaustively(candidateWorkflow, t),
      };
    } catch (error) {
      return {
        parseError:
          error instanceof Error
            ? error.message
            : t('inspector.json.errors.invalidSyntax'),
        issues:
          scope === 'step'
            ? validateStudioStepExhaustively(
                selectedStep,
                allStepIds,
                undefined,
                t
              )
            : validateStudioWorkflowExhaustively(definition, t),
      };
    }
  }, [allStepIds, definition, draft, scope, selectedStep, t]);

  const applyDraft = () => {
    if (!onDefinitionChange) return;
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setSyntaxError(t('inspector.json.errors.rootObjectRequired'));
        return;
      }
      setSyntaxError(null);
      if (scope === 'step') {
        const nextStep = parsed as StudioWorkflowStep;
        if (typeof nextStep.kind !== 'string' || typeof nextStep.id !== 'string') {
          setSyntaxError(t('inspector.json.errors.stepIdAndKindRequired'));
          return;
        }
        const oldId = selectedStep.id;
        if (nextStep.id !== oldId) {
          onDefinitionChange({
            ...definition,
            steps: definition.steps.map((step) =>
              step.id === oldId
                ? nextStep
                : {
                    ...step,
                    dependsOn: step.dependsOn.map((dep) =>
                      dep === oldId ? nextStep.id : dep
                    ),
                    branchPorts: renameBranchPortKeys(
                      step.branchPorts,
                      oldId,
                      nextStep.id
                    ),
                    ...(step.kind === 'control' &&
                    step.controlKind === 'bounded_loop' &&
                    step.loopTargetStepId === oldId
                      ? { loopTargetStepId: nextStep.id }
                      : {}),
                  }
            ),
          });
          setSelectedStepId(nextStep.id);
        } else {
          updateStep(oldId, () => nextStep);
        }
        return;
      }

      const nextWorkflow = parsed as StudioWorkflowDefinition;
      if (!Array.isArray(nextWorkflow.steps)) {
        setSyntaxError(t('inspector.json.errors.stepsArrayRequired'));
        return;
      }
      onDefinitionChange(nextWorkflow);
      if (
        !nextWorkflow.steps.some((step) => step.id === selectedStep.id) &&
        nextWorkflow.steps[0]
      ) {
        setSelectedStepId(nextWorkflow.steps[0].id);
      }
    } catch (error) {
      setSyntaxError(
        error instanceof Error
          ? error.message
          : t('inspector.json.errors.invalidSyntax')
      );
    }
  };

  const activeSyntaxError = syntaxError ?? liveInspection.parseError;
  const issues = liveInspection.issues;

  return (
    <div className="space-y-3" data-testid="inspector-json-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center rounded-lg border border-border bg-muted/65 p-0.5">
          {(
            [
              { id: 'step', label: t('inspector.json.selectedStep') },
              { id: 'workflow', label: t('inspector.json.fullWorkflow') },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={`inspector-json-scope-${item.id}`}
              onClick={() => setScope(item.id)}
              className={cn(
                'flex !h-6 items-center rounded-md px-2.5 text-2xs font-medium transition-colors',
                scope === item.id
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        {onDefinitionChange ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            onClick={applyDraft}
            data-testid="inspector-json-apply"
          >
            {t('inspector.json.apply')}
          </Button>
        ) : null}
      </div>

      <textarea
        aria-label={t('inspector.json.editorAria')}
        data-testid="inspector-json-editor"
        value={draft}
        disabled={!onDefinitionChange}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-60 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
      />

      {activeSyntaxError ? (
        <div
          role="alert"
          data-testid="inspector-json-syntax-error"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{activeSyntaxError}</span>
        </div>
      ) : null}

      <div
        data-testid="inspector-json-validation"
        className="space-y-2 rounded-lg border border-border bg-muted/25 p-2.5"
      >
        <div className="flex items-center justify-between text-xs font-medium">
          <span>{t('inspector.json.exhaustiveValidation')}</span>
          {issues.length === 0 && !activeSyntaxError ? (
            <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-success">
              <CheckCircle2 className="size-3.5" />
              {t('inspector.json.zeroIssues')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-destructive">
              <AlertCircle className="size-3.5" />
              {t('inspector.json.issueCount', { count: issues.length })}
            </span>
          )}
        </div>

        {issues.length > 0 ? (
          <ul
            className="max-h-44 space-y-1.5 overflow-y-auto"
            data-testid="inspector-json-issues-list"
          >
            {issues.map((issue, idx) => (
              <li
                key={`${issue.path}-${issue.code}-${idx}`}
                className="rounded-md border border-destructive/30 bg-card p-2 text-xs"
              >
                <div className="font-mono text-2xs font-semibold text-destructive">
                  {issue.path} · {issue.code}
                </div>
                <div className="mt-0.5 text-foreground">{issue.message}</div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
