import {
  ArrowLeft,
  ChevronDown,
  CirclePause,
  CirclePlay,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Square,
} from 'lucide-react';

import { useState } from 'react';

import { AstryxSelect, SelectorOption } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowMetrics } from './WorkflowMetrics';

const DRAFT_TASK_VALUE = '__draft__';

function formatTaskVersionBadge(
  version: bigint | number | null | undefined
): string {
  if (version == null) return 'v0.1';
  const numeric = typeof version === 'bigint' ? Number(version) : version;
  return `v${(Math.max(1, numeric) / 10).toFixed(1)}`;
}

function WorkflowSaveActionGroup({
  label,
  saveLabel,
  testLabel,
  publishLabel,
  moreLabel,
  saveDisabled,
  testDisabled,
  publishDisabled,
  showPublish,
  validationTooltip,
  onSave,
  onFullTest,
  onPublish,
}: {
  label: string;
  saveLabel: string;
  testLabel: string;
  publishLabel: string;
  moreLabel: string;
  saveDisabled: boolean;
  testDisabled: boolean;
  publishDisabled: boolean;
  showPublish: boolean;
  validationTooltip?: string;
  onSave?: () => void;
  onFullTest?: () => void;
  onPublish?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="workflow-save-action-group pointer-events-auto"
      data-testid="workflow-save-action-group"
      data-open={open ? 'true' : 'false'}
      role="group"
      aria-label={label}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        data-testid="workflow-toolbar-save-btn"
        title={validationTooltip}
        disabled={saveDisabled}
        onClick={onSave}
      >
        {saveLabel}
      </button>
      <span className="workflow-save-action-group-divider" aria-hidden="true" />
      <div className="workflow-save-action-group-extra">
        <button
          type="button"
          data-testid="workflow-toolbar-full-test-btn"
          title={validationTooltip}
          disabled={testDisabled}
          onClick={onFullTest}
        >
          {testLabel}
        </button>
        {showPublish ? (
          <>
            <span
              className="workflow-save-action-group-divider"
              aria-hidden="true"
            />
            <button
              type="button"
              data-testid="workflow-toolbar-publish-btn"
              title={validationTooltip}
              disabled={publishDisabled}
              onClick={onPublish}
            >
              {publishLabel}
            </button>
          </>
        ) : null}
      </div>
      <span className="workflow-save-action-group-divider" aria-hidden="true" />
      <button
        type="button"
        className="workflow-save-action-group-chevron"
        aria-label={moreLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown className="mx-auto size-3.5" />
      </button>
    </div>
  );
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
    onFullTest,
    fullTesting,
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

  const taskName =
    (editorName ?? definition.name).trim() ||
    t('studio.newWorkflowDefaultName');
  const taskOptions = [
    ...(selectedDefinitionId == null
      ? [
          {
            value: DRAFT_TASK_VALUE,
            label: taskName,
            endContent: (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t('studio.currentDraftBadge')}
              </span>
            ),
          },
        ]
      : catalogItems.some((item) => item.id === selectedDefinitionId)
        ? []
        : [{ value: selectedDefinitionId, label: taskName }]),
    ...catalogItems.map((item) => ({
      value: item.id,
      label: item.name,
      endContent: (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatTaskVersionBadge(item.latestVersion)}
        </span>
      ),
    })),
  ];
  const showSaveGroup = Boolean(studioMode && onDefinitionChange);

  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex items-start gap-2 overflow-x-auto pb-2">
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          data-testid="embedded-studio-back-btn"
          onClick={onBack}
          aria-label={t('studio.back')}
          title={t('studio.back')}
          className="workflow-studio-top-chrome pointer-events-auto h-7 shrink-0 gap-1 px-2 text-xs font-medium shadow-none hover:bg-[var(--surface-raised-control-hover)]"
        >
          <ArrowLeft className="size-3.5" />
          {t('studio.back')}
        </Button>
      ) : null}

      <div className="workflow-studio-top-chrome pointer-events-auto flex h-7 shrink-0 items-center">
        {onDefinitionChange ? (
          <Input
            data-testid="workflow-task-name-input"
            aria-label={t('studio.name')}
            placeholder={t('studio.taskNamePlaceholder')}
            className="h-full w-40 border-0 bg-transparent px-2 text-xs font-medium shadow-none focus-visible:ring-0"
            value={editorName ?? definition.name}
            onChange={(event) => onEditorNameChange?.(event.target.value)}
          />
        ) : (
          <span className="max-w-56 truncate px-2 text-xs font-semibold">
            {definition.name}
          </span>
        )}

        {showTaskSwitcher ? (
          <AstryxSelect
            data-testid="workflow-task-switcher-btn"
            ariaLabel={t('studio.taskListAria')}
            size="compact"
            className="workflow-studio-task-select"
            menuClassName="workflow-studio-task-menu"
            value={selectedDefinitionId ?? DRAFT_TASK_VALUE}
            options={taskOptions}
            placeholder={taskName}
            emptyLabel={t('studio.emptyTaskCatalog')}
            renderPinnedTop={
              onCreateNewTask
                ? ({ closeMenu }) => (
                    <button
                      type="button"
                      data-testid="workflow-task-create-new"
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => {
                        closeMenu();
                        onCreateNewTask();
                      }}
                    >
                      <Plus className="size-3.5" />
                      <span>{t('studio.createNewTask')}</span>
                    </button>
                  )
                : undefined
            }
            renderOption={(option) => (
              <span
                data-testid={
                  option.value === DRAFT_TASK_VALUE
                    ? 'workflow-task-option-draft'
                    : `workflow-task-option-${option.value}`
                }
                className="min-w-0 flex-1"
              >
                <SelectorOption
                  label={option.label}
                  endContent={option.endContent}
                  className="astryx-select-option-label"
                />
              </span>
            )}
            onChange={(nextId) => {
              if (nextId === DRAFT_TASK_VALUE) return;
              onSelectTask?.(nextId);
            }}
          />
        ) : null}
      </div>

      {showSaveGroup ? (
        <WorkflowSaveActionGroup
          label={t('studio.saveActions')}
          moreLabel={t('studio.moreSaveActions')}
          saveLabel={
            saving || publishing ? t('studio.saving') : t('studio.saveChanges')
          }
          testLabel={
            fullTesting ? t('studio.fullTesting') : t('studio.fullTest')
          }
          publishLabel={
            publishing ? t('studio.publishing') : t('studio.publishTask')
          }
          validationTooltip={validationTooltip}
          saveDisabled={!dirty || saving || publishing || hasValidationIssues}
          testDisabled={
            !onFullTest ||
            fullTesting ||
            saving ||
            publishing ||
            hasValidationIssues
          }
          publishDisabled={
            !onPublish || publishing || saving || hasValidationIssues
          }
          showPublish={Boolean(onPublish)}
          onSave={onSave ?? onPublish}
          onFullTest={onFullTest}
          onPublish={onPublish}
        />
      ) : null}

      <div className="workflow-studio-top-chrome pointer-events-auto ml-auto flex h-7 shrink-0 items-center gap-0.5 pl-1 pr-0.5">
        {onDefinitionChange ? (
          <>
            {workspaceConfig ? (
              <Button
                size="sm"
                variant={workspaceOpen ? 'secondary' : 'ghost'}
                className="h-7 px-2 text-xs"
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

            {studioMode ? null : (
              <>
                <span title={validationTooltip} className="inline-flex">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
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
                      className="h-7"
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

        <WorkflowMetrics
          bare
          nodeCount={definition.steps.length}
          agentCount={
            definition.steps.filter(
              (step) => step.kind === 'agent' || step.kind === 'session'
            ).length
          }
          releaseVersion={releaseVersion}
          dirty={Boolean(dirty)}
        />
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
