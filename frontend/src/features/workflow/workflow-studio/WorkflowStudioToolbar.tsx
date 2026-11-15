import {
  ArrowLeft,
  Bell,
  Bot,
  ChevronDown,
  CirclePause,
  CirclePlay,
  GitBranch,
  Layers,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Undo2,
  Users,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { formatOrchestratorLabel } from '@/features/pulse';

import { resolveWorkflowAgentId } from '../workflowAgent';
import { WORKFLOW_PRESET_TEMPLATES } from './presetTemplates';
import { StudioAgentIcon } from './StudioAgentIcon';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowMetrics } from './WorkflowMetrics';
import { WorkflowReplayPopover } from './WorkflowReplayPopover';

export function WorkflowStudioToolbar({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const {
    t,
    onBack,
    onDefinitionChange,
    editorName,
    definition,
    onEditorNameChange,
    releaseVersion,
    dirty,
    workspaceConfig,
    workspaceOpen,
    setWorkspaceOpen,
    setSelectedStepId,
    workspaceSummary,
    addStep,
    applyPreset,
    agentOptions,
    config,
    onUndo,
    canUndo,
    showStopActions,
    onStopRun,
    onTerminateRun,
    primaryStopAction,
    setPrimaryStopAction,
    stopActionsDisabled,
    onReset,
    setLogStepId,
    setDecisionJson,
    setDecisionError,
    setJsonError,
    resetDisabled,
    onSave,
    saving,
    unsavedStepIds,
    validationIssues,
    onPublish,
    publishing,
    run,
    onPauseRun,
    onResumeRun,
  } = studio;
  const hasValidationIssues = validationIssues.length > 0;
  const validationTooltip = hasValidationIssues
    ? t('studio.fixValidationIssuesTooltip', {
        count: validationIssues.length,
        defaultValue: `Fix ${validationIssues.length} validation issue(s) before saving or publishing`,
      })
    : undefined;

  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex items-start gap-2 overflow-x-auto pb-2">
      {onBack ? (
        <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center p-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={onBack}
            aria-label={t('studio.back')}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center gap-1.5 p-1">
        {onDefinitionChange ? (
          <Input
            aria-label={t('studio.name')}
            className="h-8 w-40 border-transparent bg-transparent text-sm font-semibold"
            value={editorName ?? definition.name}
            onChange={(event) => onEditorNameChange?.(event.target.value)}
          />
        ) : (
          <span className="max-w-56 truncate px-2 text-sm font-semibold">
            {definition.name}
          </span>
        )}
        {definition.orchestratorPreset ? (
          <span
            data-testid="workflow-preset-pill"
            className="rounded-full border border-border bg-muted/70 px-2 py-0.5 text-2xs font-medium text-foreground"
          >
            {formatOrchestratorLabel(definition.orchestratorPreset)}
          </span>
        ) : null}
      </div>

      <WorkflowMetrics
        nodeCount={definition.steps.length}
        agentCount={
          definition.steps.filter(
            (step) => step.kind === 'agent' || step.kind === 'session'
          ).length
        }
        releaseVersion={releaseVersion}
        dirty={Boolean(dirty)}
      />

      <div className="workflow-studio-floating-controls pointer-events-auto ml-auto flex shrink-0 items-center gap-1 p-1">
        {onDefinitionChange ? (
          <>
            {workspaceConfig ? (
              <Button
                size="sm"
                variant={workspaceOpen ? 'secondary' : 'ghost'}
                aria-expanded={workspaceOpen}
                onClick={() => {
                  setWorkspaceOpen((open) => !open);
                  setSelectedStepId(null);
                }}
              >
                <SlidersHorizontal className="mr-1.5 size-3.5" />
                {workspaceSummary ?? t('studio.workspace')}
              </Button>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="workflow-presets-trigger"
                >
                  <Layers className="mr-1 size-3.5" />
                  Templates
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                sideOffset={8}
                className="w-72"
              >
                {WORKFLOW_PRESET_TEMPLATES.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    data-testid={`workflow-preset-${preset.id}`}
                    onSelect={() => applyPreset(preset.id)}
                    className="flex flex-col items-start gap-0.5 py-2"
                  >
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Sparkles className="size-3.5 text-primary" />
                      {preset.label}
                    </span>
                    <span className="text-2xs leading-4 text-muted-foreground">
                      {preset.summary}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <WorkflowReplayPopover studio={studio} />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost">
                  <Plus className="mr-1 size-3.5" /> {t('studio.addNode')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={8} className="w-56">
                <DropdownMenuItem onSelect={() => addStep('trigger')}>
                  <Zap className="size-4" />
                  Event Trigger
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('session')}>
                  <Terminal className="size-4" />
                  Session Step (Fresh Context)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('bot')}>
                  <Bot className="size-4" />
                  Bot Step (Persistent Memory)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('group_stage')}>
                  <Users className="size-4" />
                  Group Stage
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('user_gate')}>
                  <ShieldCheck className="size-4" />
                  User Gate
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('control')}>
                  <GitBranch className="size-4" />
                  Flow Control
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('outbox_action')}>
                  <Send className="size-4" />
                  Outbox Action
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => addStep('agent')}>
                  <StudioAgentIcon
                    agentId={resolveWorkflowAgentId(
                      agentOptions,
                      config?.executor_profile?.executor
                    )}
                    agentOptions={agentOptions}
                    className="size-4"
                  />
                  {t('studio.agentStep')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStep('notify')}>
                  <Bell className="size-4" /> {t('studio.notify')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label={t('studio.undo')}
              title={t('studio.undo')}
            >
              <Undo2 className="size-3.5" />
            </Button>
            {showStopActions || onStopRun || onTerminateRun ? (
              <div className="raised-control inline-flex h-7 items-center overflow-hidden rounded-lg">
                <button
                  type="button"
                  className="inline-flex h-7 items-center justify-center gap-1.5 px-2.5 text-xs font-medium leading-none disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={
                    primaryStopAction === 'stop'
                      ? t('studio.stop')
                      : t('studio.terminate')
                  }
                  disabled={
                    stopActionsDisabled ||
                    (primaryStopAction === 'stop'
                      ? !onStopRun
                      : !onTerminateRun)
                  }
                  onClick={
                    primaryStopAction === 'stop' ? onStopRun : onTerminateRun
                  }
                >
                  <Square className="size-3.5" />
                  {primaryStopAction === 'stop'
                    ? t('studio.stop')
                    : t('studio.terminate')}
                </button>
                <span className="h-3.5 w-px bg-border" aria-hidden />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
                      aria-label={t('studio.chooseStopAction')}
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => setPrimaryStopAction('stop')}
                    >
                      <CirclePause /> {t('studio.stop')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => setPrimaryStopAction('terminate')}
                    >
                      <Square /> {t('studio.terminate')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
            {showStopActions || onReset ? (
              <Button
                size="sm"
                variant="outline"
                disabled={resetDisabled}
                onClick={() => {
                  setSelectedStepId(null);
                  setLogStepId(null);
                  setWorkspaceOpen(false);
                  setDecisionJson('{}');
                  setDecisionError(null);
                  setJsonError(null);
                  onReset?.();
                }}
              >
                <RotateCcw className="mr-1.5 size-3.5" />
                {t('studio.reset')}
              </Button>
            ) : null}
            {hasValidationIssues ? (
              <span
                data-testid="workflow-toolbar-validation-badge"
                title={validationTooltip}
                className="inline-flex h-7 items-center rounded-md border border-destructive/35 bg-destructive/10 px-2 text-2xs font-semibold text-destructive tabular-nums"
              >
                {t('studio.validationIssueCount', {
                  count: validationIssues.length,
                  defaultValue: `${validationIssues.length} issue(s)`,
                })}
              </span>
            ) : null}
            <span title={validationTooltip} className="inline-flex">
              <Button
                size="sm"
                variant="outline"
                onClick={onSave}
                title={validationTooltip}
                disabled={
                  !dirty ||
                  saving ||
                  unsavedStepIds.size > 0 ||
                  hasValidationIssues
                }
              >
                {saving ? t('studio.saving') : t('studio.save')}
              </Button>
            </span>
            <span title={validationTooltip} className="inline-flex">
              <Button
                size="sm"
                onClick={onPublish}
                title={validationTooltip}
                disabled={
                  publishing ||
                  unsavedStepIds.size > 0 ||
                  hasValidationIssues
                }
              >
                {publishing ? t('studio.publishing') : t('studio.publish')}
              </Button>
            </span>
          </>
        ) : (
          <>
            <WorkflowReplayPopover studio={studio} />
            {run && run.controlState === 'active' ? (
              <Button size="sm" variant="outline" onClick={onPauseRun}>
                <CirclePause className="mr-1.5 size-3.5" /> {t('studio.pause')}
              </Button>
            ) : run ? (
              <Button size="sm" variant="outline" onClick={onResumeRun}>
                <CirclePlay className="mr-1.5 size-3.5" /> {t('studio.resume')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
