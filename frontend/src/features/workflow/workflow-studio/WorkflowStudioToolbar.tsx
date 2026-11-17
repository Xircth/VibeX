import {
  ArrowLeft,
  Check,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowMetrics } from './WorkflowMetrics';

function formatTaskVersionBadge(
  version: bigint | number | null | undefined
): string {
  if (version == null) return 'v0.1';
  const numeric = typeof version === 'bigint' ? Number(version) : version;
  return `v${(Math.max(1, numeric) / 10).toFixed(1)}`;
}

export function WorkflowStudioToolbar({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const {
    t,
    studioMode,
    onBack,
    onDefinitionChange,
    editorName,
    definition,
    onEditorNameChange,
    taskCatalog,
    selectedDefinitionId,
    onSelectTask,
    onCreateNewTask,
    rightToolbarSlot,
    releaseVersion,
    dirty,
    workspaceConfig,
    workspaceOpen,
    setWorkspaceOpen,
    setSelectedStepId,
    workspaceSummary,
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
      })
    : undefined;
  const showTaskSwitcher = Boolean(onSelectTask || onCreateNewTask);
  const catalogItems = taskCatalog ?? [];

  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex items-start gap-2 overflow-x-auto pb-2">
      {onBack ? (
        <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center p-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            data-testid="embedded-studio-back-btn"
            onClick={onBack}
            aria-label={t('studio.back')}
            title={t('studio.back')}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <div className="workflow-studio-floating-controls pointer-events-auto flex shrink-0 items-center gap-1 p-1">
        {onDefinitionChange ? (
          <Input
            data-testid="workflow-task-name-input"
            aria-label={t('studio.name')}
            placeholder={t('studio.taskNamePlaceholder')}
            className="h-8 w-52 border-transparent bg-transparent text-sm font-semibold focus-visible:ring-0"
            value={editorName ?? definition.name}
            onChange={(event) => onEditorNameChange?.(event.target.value)}
          />
        ) : (
          <span className="max-w-56 truncate px-2 text-sm font-semibold">
            {definition.name}
          </span>
        )}

        {showTaskSwitcher ? (
          <>
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  data-testid="workflow-task-switcher-btn"
                  aria-label={t('studio.taskListAria')}
                  title={t('studio.taskListAria')}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {onCreateNewTask ? (
                  <>
                    <DropdownMenuItem
                      data-testid="workflow-task-create-new"
                      onSelect={() => onCreateNewTask()}
                    >
                      <Plus className="size-3.5" />
                      <span>{t('studio.createNewTask')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}

                {selectedDefinitionId == null ? (
                  <DropdownMenuItem
                    data-testid="workflow-task-option-draft"
                    className="justify-between gap-2"
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Check className="size-3.5 shrink-0 text-primary" />
                      <span className="truncate">
                        {(editorName ?? definition.name).trim() ||
                          t('studio.newWorkflowDefaultName')}
                      </span>
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {t('studio.currentDraftBadge')}
                    </span>
                  </DropdownMenuItem>
                ) : null}

                {catalogItems.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {t('studio.emptyTaskCatalog')}
                  </div>
                ) : (
                  catalogItems.map((item) => {
                    const isSelected = item.id === selectedDefinitionId;
                    return (
                      <DropdownMenuItem
                        key={item.id}
                        data-testid={`workflow-task-option-${item.id}`}
                        className="justify-between gap-2"
                        onSelect={() => onSelectTask?.(item.id)}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {isSelected ? (
                            <Check className="size-3.5 shrink-0 text-primary" />
                          ) : (
                            <span
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate">{item.name}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                          {formatTaskVersionBadge(item.latestVersion)}
                        </span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
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
                })}
              </span>
            ) : null}

            {studioMode ? (
              <span title={validationTooltip} className="inline-flex">
                <Button
                  size="sm"
                  data-testid="workflow-toolbar-save-btn"
                  onClick={onSave ?? onPublish}
                  title={validationTooltip}
                  disabled={
                    !dirty || saving || publishing || hasValidationIssues
                  }
                >
                  {saving || publishing
                    ? t('studio.saving')
                    : t('studio.saveChanges')}
                </Button>
              </span>
            ) : (
              <>
                <span title={validationTooltip} className="inline-flex">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onSave}
                    title={validationTooltip}
                    disabled={!dirty || saving || hasValidationIssues}
                  >
                    {saving ? t('studio.saving') : t('studio.save')}
                  </Button>
                </span>
                {onPublish ? (
                  <span title={validationTooltip} className="inline-flex">
                    <Button
                      size="sm"
                      onClick={onPublish}
                      title={validationTooltip}
                      disabled={publishing || hasValidationIssues}
                    >
                      {publishing
                        ? t('studio.publishing')
                        : t('studio.publish')}
                    </Button>
                  </span>
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
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

        {rightToolbarSlot ? (
          <>
            <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
            {rightToolbarSlot}
          </>
        ) : null}
      </div>
    </div>
  );
}
