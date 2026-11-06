import { AgentSessionControlsErrorCard } from '@/components/sessions/SessionCreationStatusCard';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { WorkflowStep } from 'shared/types';

import { StudioAgentIcon } from './StudioAgentIcon';
import { DEFAULT_OUTPUT_SCHEMA } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';

type AgentStep = Extract<WorkflowStep, { kind: 'agent' }>;

export function WorkflowStudioInspectorAgent({
  selectedStep,
  studio,
}: {
  selectedStep: AgentStep;
  studio: WorkflowStudioView;
}) {
  const {
    t,
    onDefinitionChange,
    updateStep,
    agentOptions,
    agentControls,
    agentControlsLoading,
    agentControlsError,
    outputTab,
    setOutputTab,
    updateJson,
  } = studio;

  return (
    <>
      <div className="space-y-1.5">
        <Label>{t('studio.agent')}</Label>
        <Select
          value={selectedStep.agentId}
          disabled={!onDefinitionChange}
          onValueChange={(agentId) =>
            updateStep(selectedStep.id, (step) =>
              step.kind === 'agent'
                ? {
                    ...step,
                    agentId,
                    executorProfileId: {
                      executor: agentId,
                      variant: null,
                    },
                    modeOverride: null,
                    configOverrides: {},
                  }
                : step
            )
          }
        >
          <SelectTrigger>
            <SelectValue>
              <span className="flex items-center gap-2">
                <StudioAgentIcon
                  agentId={selectedStep.agentId}
                  agentOptions={agentOptions}
                  className="size-4"
                />
                {agentOptions.find(
                  (agent) => agent.value === selectedStep.agentId
                )?.label ?? selectedStep.agentId}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(agentOptions.some((agent) => agent.value === selectedStep.agentId)
              ? agentOptions
              : [
                  ...agentOptions,
                  {
                    value: selectedStep.agentId,
                    label: selectedStep.agentId,
                  },
                ]
            ).map((agent) => (
              <SelectItem
                key={agent.value}
                value={agent.value}
                disabled={agent.runnable === false}
              >
                <span className="flex items-center gap-2">
                  <StudioAgentIcon
                    agentId={agent.value}
                    agentOptions={agentOptions}
                    className="size-4"
                  />
                  {agent.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        {agentControls ? (
          <SessionSettingsSummary
            sessionModes={{
              current: agentControls.current_mode ?? null,
              modes: agentControls.modes,
            }}
            selectedMode={selectedStep.modeOverride}
            onSelectMode={(modeOverride) =>
              updateStep(selectedStep.id, (step) =>
                step.kind === 'agent' ? { ...step, modeOverride } : step
              )
            }
            options={agentControls.config_options}
            pending={Object.fromEntries(
              Object.entries(selectedStep.configOverrides).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string'
              )
            )}
            onSelectConfigOption={(key, value) =>
              updateStep(selectedStep.id, (step) =>
                step.kind === 'agent'
                  ? {
                      ...step,
                      configOverrides: {
                        ...step.configOverrides,
                        [key]: value,
                      },
                    }
                  : step
              )
            }
            disabled={!onDefinitionChange}
            dropdownSide="bottom"
          />
        ) : (
          <div className="space-y-2">
            <div className="flex min-h-9 items-center rounded-lg bg-muted/55 px-3 text-xs text-muted-foreground">
              {agentControlsLoading
                ? t('studio.sessionConfigurationLoading')
                : t('studio.sessionConfigurationUnavailable')}
            </div>
            {!agentControlsLoading && agentControlsError ? (
              <AgentSessionControlsErrorCard
                agentId={selectedStep.agentId}
                error={agentControlsError}
              />
            ) : null}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="workflow-prompt">{t('studio.prompt')}</Label>
        <textarea
          id="workflow-prompt"
          className="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          value={selectedStep.prompt}
          disabled={!onDefinitionChange}
          onChange={(event) =>
            updateStep(selectedStep.id, (step) => ({
              ...step,
              prompt: event.target.value,
            }))
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t('studio.afterCompletion')}</Label>
        <Select
          value={selectedStep.completionPolicy}
          disabled={!onDefinitionChange}
          onValueChange={(completionPolicy: 'automatic' | 'manual') =>
            updateStep(selectedStep.id, (step) => ({
              ...step,
              completionPolicy,
            }))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="automatic">
              {t('studio.continueAutomatically')}
            </SelectItem>
            <SelectItem value="manual">
              {t('studio.requireConfirmation')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label
          htmlFor={
            outputTab === 'brief'
              ? 'workflow-output-description'
              : 'workflow-output-schema'
          }
        >
          {t('studio.outputRequirement')}
        </Label>
        <div className="flex shrink-0 items-center rounded-lg bg-muted/65 p-0.5">
          {(['brief', 'strict'] as const).map((tab) => (
            <button
              type="button"
              key={tab}
              className={cn(
                'flex !h-7 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium',
                outputTab === tab
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              )}
              onClick={() => {
                setOutputTab(tab);
                if (!onDefinitionChange) return;
                if (tab === 'brief') {
                  updateStep(selectedStep.id, (step) => ({
                    ...step,
                    outputSchema: null,
                  }));
                  return;
                }
                updateStep(selectedStep.id, (step) => ({
                  ...step,
                  outputDescription: null,
                  outputSchema:
                    step.kind === 'agent' && step.outputSchema
                      ? step.outputSchema
                      : DEFAULT_OUTPUT_SCHEMA,
                }));
              }}
            >
              {tab === 'brief'
                ? t('studio.outputBrief')
                : t('studio.outputStrict')}
            </button>
          ))}
        </div>
        {outputTab === 'brief' ? (
          <textarea
            id="workflow-output-description"
            key={`${selectedStep.id}-description`}
            defaultValue={selectedStep.outputDescription ?? ''}
            disabled={!onDefinitionChange}
            onBlur={(event) =>
              updateStep(selectedStep.id, (step) => ({
                ...step,
                outputDescription: event.target.value.trim()
                  ? event.target.value.trim()
                  : null,
                outputSchema: null,
              }))
            }
            className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          />
        ) : (
          <textarea
            id="workflow-output-schema"
            key={`${selectedStep.id}-schema`}
            defaultValue={
              selectedStep.outputSchema
                ? JSON.stringify(selectedStep.outputSchema, null, 2)
                : ''
            }
            disabled={!onDefinitionChange}
            onBlur={(event) =>
              updateJson(event.target.value, (outputSchema) =>
                updateStep(selectedStep.id, (step) => ({
                  ...step,
                  outputDescription: null,
                  outputSchema,
                }))
              )
            }
            className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          />
        )}
      </div>
    </>
  );
}
