import { GitFork, MessageSquare, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { WorkflowStepConversation } from '../WorkflowStepConversation';
import { renameStepOutputBindings } from './workflowGraph';
import type { WorkflowStudioView } from './useWorkflowStudio';
import { WorkflowStudioInspectorInfo } from './WorkflowStudioInspectorInfo';

export function WorkflowStudioInspector({
  studio,
}: {
  studio: WorkflowStudioView;
}) {
  const {
    selectedStep,
    inspectorRef,
    t,
    onDefinitionChange,
    definition,
    setUnsavedStepIds,
    setSelectedStepId,
    inspectorTab,
    setInspectorTab,
    unsavedStepIds,
    selectedRun,
    activeWorktree,
    onPauseStep,
    onSubmitStepInput,
    onAcceptCandidate,
    events,
  } = studio;

  if (!selectedStep) return null;

  return (
    <aside
      ref={inspectorRef}
      className="workflow-node-inspector absolute right-3 top-16 z-20 flex w-[min(430px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <Input
          aria-label={t('studio.nodeName')}
          className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-1 text-sm font-semibold"
          value={selectedStep.id}
          disabled={!onDefinitionChange}
          onChange={(event) => {
            const nextId = event.target.value;
            if (
              !nextId ||
              definition.steps.some(
                (step) => step.id === nextId && step.id !== selectedStep.id
              )
            )
              return;
            onDefinitionChange?.({
              ...definition,
              steps: definition.steps.map((step) => ({
                ...step,
                id: step.id === selectedStep.id ? nextId : step.id,
                dependsOn: step.dependsOn.map((dependency) =>
                  dependency === selectedStep.id ? nextId : dependency
                ),
                inputBindings: renameStepOutputBindings(
                  step.inputBindings,
                  selectedStep.id,
                  nextId
                ),
              })),
            });
            setUnsavedStepIds((current) => {
              const next = new Set(current);
              next.delete(selectedStep.id);
              next.add(nextId);
              return next;
            });
            setSelectedStepId(nextId);
          }}
        />
        <div className="flex shrink-0 items-center rounded-lg bg-muted/65 p-0.5">
          {(['info', 'conversation'] as const).map((tab) => (
            <button
              type="button"
              key={tab}
              className={cn(
                'flex !h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium',
                inspectorTab === tab
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground'
              )}
              onClick={() => setInspectorTab(tab)}
            >
              {tab === 'info' ? (
                <GitFork className="size-3.5" />
              ) : (
                <MessageSquare className="size-3.5" />
              )}
              {tab === 'info' ? t('studio.node') : t('studio.conversation')}
            </button>
          ))}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => {
            setSelectedStepId(null);
          }}
          aria-label={t('studio.close')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div
        className={cn(
          'min-h-0 flex-1 p-3.5 pt-1',
          inspectorTab === 'conversation' ? 'overflow-hidden' : 'overflow-auto'
        )}
      >
        {inspectorTab === 'conversation' ? (
          <WorkflowStepConversation
            stepRun={selectedRun}
            saved={!unsavedStepIds.has(selectedStep.id)}
            workspacePath={activeWorktree?.path}
            onPause={() => onPauseStep?.(selectedStep.id)}
            onSubmit={(text) => onSubmitStepInput?.(selectedStep.id, text)}
            onConfirm={
              selectedRun?.awaitingAcceptance
                ? () => onAcceptCandidate?.(selectedStep.id)
                : undefined
            }
          />
        ) : (
          <WorkflowStudioInspectorInfo
            selectedStep={selectedStep}
            studio={studio}
          />
        )}
      </div>
      {events.length ? (
        <div className="border-t px-3.5 py-2 text-[10px] text-muted-foreground">
          {t('studio.eventSequence', {
            count: events.length,
            sequence: String(events.at(-1)?.sequence ?? 0),
          })}
        </div>
      ) : null}
    </aside>
  );
}
