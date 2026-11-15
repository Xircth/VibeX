import { Bot, Terminal } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import type { StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowStudioInspectorAgent } from './WorkflowStudioInspectorAgent';
import { WorkflowStudioInspectorStagesAndFlow } from './WorkflowStudioInspectorStagesAndFlow';
import { WorkflowStudioInspectorTriggerAndBot } from './WorkflowStudioInspectorTriggerAndBot';
import { switchExecutionPrimitive } from './workflowStepPresentation';

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
          <Label>{t('inspector.primitive.label')}</Label>
          <div
            role="radiogroup"
            aria-label={t('inspector.primitive.label')}
            className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/65 p-0.5"
          >
            {(
              [
                {
                  id: 'session',
                  label: t('inspector.primitive.sessionLabel'),
                  sub: t('inspector.primitive.sessionSub'),
                  icon: Terminal,
                },
                {
                  id: 'bot',
                  label: t('inspector.primitive.botLabel'),
                  sub: t('inspector.primitive.botSub'),
                  icon: Bot,
                },
              ] as const
            ).map((item, index, items) => {
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
                  tabIndex={active ? 0 : -1}
                  aria-checked={active}
                  disabled={!onDefinitionChange}
                  data-testid={`inspector-primitive-${item.id}`}
                  onClick={() =>
                    updateStep(selectedStep.id, (step) =>
                      switchExecutionPrimitive(
                        step,
                        item.id,
                        defaultAgentId,
                        outputLanguage,
                        t
                      )
                    )
                  }
                  onKeyDown={(event) => {
                    if (
                      !onDefinitionChange ||
                      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                    ) {
                      return;
                    }
                    event.preventDefault();
                    const delta = event.key === 'ArrowRight' ? 1 : -1;
                    const nextIndex =
                      (index + delta + items.length) % items.length;
                    const nextPrimitive = items[nextIndex].id;
                    updateStep(selectedStep.id, (step) =>
                      switchExecutionPrimitive(
                        step,
                        nextPrimitive,
                        defaultAgentId,
                        outputLanguage,
                        t
                      )
                    );
                    const group = event.currentTarget.parentElement;
                    const buttons =
                      group?.querySelectorAll<HTMLButtonElement>(
                        '[role="radio"]'
                      );
                    buttons?.[nextIndex]?.focus();
                  }}
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
      ) : selectedStep.kind === 'bot' || selectedStep.kind === 'trigger' ? (
        <WorkflowStudioInspectorTriggerAndBot
          selectedStep={selectedStep}
          studio={studio}
        />
      ) : (
        <WorkflowStudioInspectorStagesAndFlow
          selectedStep={selectedStep}
          studio={studio}
        />
      )}
    </div>
  );
}
