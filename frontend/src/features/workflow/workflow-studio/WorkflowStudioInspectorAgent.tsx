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
import type { PulseWorkspaceIsolation } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import { StudioAgentIcon } from './StudioAgentIcon';
import { DEFAULT_OUTPUT_SCHEMA, type StudioWorkflowStep } from './types';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { resolveSessionIsolation } from './workflowStepPresentation';

type SessionLikeStep = Extract<
  StudioWorkflowStep,
  { kind: 'agent' | 'session' }
>;

export function WorkflowStudioInspectorAgent({
  selectedStep,
  studio,
}: {
  selectedStep: SessionLikeStep;
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

  const isolation = resolveSessionIsolation(selectedStep);

  return (
    <>
      <div className="space-y-1.5">
        <Label>{t('studio.agent')}</Label>
        <Select
          value={selectedStep.agentId}
          disabled={!onDefinitionChange}
          onValueChange={(agentId) =>
            updateStep(selectedStep.id, (step) =>
              step.kind === 'agent' || step.kind === 'session'
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
        <Label>{t('inspector.session.workspaceIsolation')}</Label>
        <Select
          value={isolation}
          disabled={!onDefinitionChange}
          onValueChange={(nextIsolation: PulseWorkspaceIsolation) =>
            updateStep(selectedStep.id, (step) => {
              if (step.kind === 'session') {
                return { ...step, workspaceIsolation: nextIsolation };
              }
              if (step.kind === 'agent') {
                return {
                  ...step,
                  workspaceIsolation: nextIsolation,
                  workspaceAccess:
                    nextIsolation === 'isolated_worktree'
                      ? 'write_isolated'
                      : nextIsolation === 'scratch'
                        ? 'read_only_shared'
                        : 'native',
                };
              }
              return step;
            })
          }
        >
          <SelectTrigger data-testid="inspector-session-isolation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="isolated_worktree">
              {t('inspector.session.isolationOptions.isolated_worktree')}
            </SelectItem>
            <SelectItem value="project_root">
              {t('inspector.session.isolationOptions.project_root')}
            </SelectItem>
            {isolation === 'scratch' ? (
              <SelectItem value="scratch">
                {t('inspector.session.isolationOptions.scratch')}
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t('inspector.session.workspaceIsolationHint')}
        </p>
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
                step.kind === 'agent' || step.kind === 'session'
                  ? { ...step, modeOverride }
                  : step
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
                step.kind === 'agent' || step.kind === 'session'
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
            updateStep(selectedStep.id, (step) =>
              step.kind === 'agent' || step.kind === 'session'
                ? {
                    ...step,
                    prompt: event.target.value,
                  }
                : step
            )
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t('studio.afterCompletion')}</Label>
        <Select
          value={selectedStep.completionPolicy}
          disabled={!onDefinitionChange}
          onValueChange={(completionPolicy: 'automatic' | 'manual') =>
            updateStep(selectedStep.id, (step) =>
              step.kind === 'agent' || step.kind === 'session'
                ? {
                    ...step,
                    completionPolicy,
                  }
                : step
            )
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
                  updateStep(selectedStep.id, (step) =>
                    step.kind === 'agent' || step.kind === 'session'
                      ? {
                          ...step,
                          outputSchema: null,
                        }
                      : step
                  );
                  return;
                }
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'agent' || step.kind === 'session'
                    ? {
                        ...step,
                        outputDescription: null,
                        outputSchema: step.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
                      }
                    : step
                );
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
              updateStep(selectedStep.id, (step) =>
                step.kind === 'agent' || step.kind === 'session'
                  ? {
                      ...step,
                      outputDescription: event.target.value.trim()
                        ? event.target.value.trim()
                        : null,
                      outputSchema: null,
                    }
                  : step
              )
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
                updateStep(selectedStep.id, (step) =>
                  step.kind === 'agent' || step.kind === 'session'
                    ? {
                        ...step,
                        outputDescription: null,
                        outputSchema,
                      }
                    : step
                )
              )
            }
            className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          />
        )}
      </div>
    </>
  );
}
