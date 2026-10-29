import {
  ArrowLeft,
  Bell,
  ChevronDown,
  CirclePause,
  CirclePlay,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Undo2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

import { resolveWorkflowAgentId } from '../workflowAgent';
import { StudioAgentIcon } from './StudioAgentIcon';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowMetrics } from './WorkflowMetrics';

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
    onPublish,
    publishing,
    run,
    onPauseRun,
    onResumeRun,
  } = studio;

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

      <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center p-1">
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
      </div>

      <WorkflowMetrics
        nodeCount={definition.steps.length}
        agentCount={
          definition.steps.filter((step) => step.kind === 'agent').length
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
                <Button size="sm" variant="ghost">
                  <Plus className="mr-1 size-3.5" /> {t('studio.addNode')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={8}>
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
            <Button
              size="sm"
              variant="outline"
              onClick={onSave}
              disabled={!dirty || saving || unsavedStepIds.size > 0}
            >
              {saving ? t('studio.saving') : t('studio.save')}
            </Button>
            <Button
              size="sm"
              onClick={onPublish}
              disabled={publishing || unsavedStepIds.size > 0}
            >
              {publishing ? t('studio.publishing') : t('studio.publish')}
            </Button>
          </>
        ) : run && run.controlState === 'active' ? (
          <Button size="sm" variant="outline" onClick={onPauseRun}>
            <CirclePause className="mr-1.5 size-3.5" /> {t('studio.pause')}
          </Button>
        ) : run ? (
          <Button size="sm" variant="outline" onClick={onResumeRun}>
            <CirclePlay className="mr-1.5 size-3.5" /> {t('studio.resume')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
